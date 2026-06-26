/**
 * First-run install page. Presented when `GET /api/install/status`
 * reports `installed: false`. Allows the current iframe user to pick
 * the portal users who should have admin access inside the app and
 * saves the selection through `POST /api/install`. On success it
 * kicks off `POST /api/install/register-placements` and redirects
 * to the templates list.
 *
 * UX:
 *  - Debounced search input wired to `GET /api/users?search=`.
 *  - Checkbox-list of matching users; selection persists across
 *    searches in a local Map keyed by numeric user id.
 *  - Optional UF_CRM_* field binding (skipped for now — the editor
 *    can fill it in later through SettingsPage).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { installApi, usersApi, ApiError, type PortalUserDTO } from '@/lib/api';
import { isB24Available, installFinishB24, getB24Auth } from '@/lib/b24';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function InstallPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);
  const [selected, setSelected] = useState<Map<number, PortalUserDTO>>(new Map());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /* ------------------------------------------------------------ */
  /* Install status — decides whether to render the form at all   */
  /* ------------------------------------------------------------ */
  const statusQuery = useQuery({
    queryKey: ['install', 'status'],
    queryFn: () => installApi.status(),
    enabled: isB24Available(),
  });

  /* ------------------------------------------------------------ */
  /* User search                                                   */
  /* ------------------------------------------------------------ */
  const usersQuery = useQuery({
    queryKey: ['users', 'search', debounced],
    queryFn: () => usersApi.search(debounced),
    enabled: isB24Available() && statusQuery.data?.installed === false,
  });

  /* ------------------------------------------------------------ */
  /* Save mutation                                                 */
  /* ------------------------------------------------------------ */
  const saveMutation = useMutation({
    mutationFn: async (adminUserIds: number[]) => {
      // 1. Persist app settings (admin user IDs) in our DB. We also
      //    forward the SDK auth snapshot so the backend can store the
      //    OAuth refresh token for server-to-server flows (webhook
      //    executor). If the SDK hasn't produced an auth payload yet
      //    (should never happen at this point, but be defensive), we
      //    just skip it — the install still succeeds.
      const sdkAuth = getB24Auth();
      const res = await installApi.install({
        adminUserIds,
        oauth: sdkAuth
          ? {
              accessToken: sdkAuth.accessToken,
              refreshToken: sdkAuth.refreshToken,
              expiresAt: sdkAuth.expiresAt,
              memberId: sdkAuth.memberId,
              domain: sdkAuth.domain,
            }
          : undefined,
      });

      // 2. Register placements via the backend (which calls placement.bind).
      //    BEST-EFFORT: a failed bind must NEVER abort the install flow.
      //    Until step 3 (installFinish) runs, Bitrix24 keeps the app in
      //    the "not installed" state — regular users see "ask the
      //    administrator to finish install" and the admin is shown the
      //    install page on every open. Previously a placement.bind error
      //    threw here and step 3 never executed, trapping the app
      //    permanently. We now only collect a warning and proceed; the
      //    admin can (re-)bind placements later from the Settings page,
      //    where placement.bind succeeds once the app is fully installed.
      let placementWarning: string | null = null;
      try {
        const reg = await installApi.registerPlacements({});
        // eslint-disable-next-line no-console
        console.info('register-placements result:', reg);

        const failed = Object.entries(reg.results).filter(([, v]) => !v.ok);
        if (failed.length > 0) {
          const details = failed
            .map(([name, v]) => `${name}: ${v.code ?? ''} ${v.error ?? ''}`.trim())
            .join('; ');
          const allowed = reg.availablePlacements?.length
            ? `Доступные placement-ы портала: ${reg.availablePlacements.join(', ')}.`
            : reg.placementListError
              ? `placement.list упал: ${reg.placementListError}.`
              : 'placement.list вернул пустой список.';
          placementWarning = `placement.bind не сработал — вкладка может не появиться в карточке сделки. ${details}. ${allowed} Проверьте, что в манифесте локального приложения объявлен placement CRM_DEAL_DETAIL_TAB и выдан scope "placement". Встройку можно повторно зарегистрировать в настройках.`;
        }
      } catch (err) {
        placementWarning = err instanceof Error ? err.message : String(err);
      }
      if (placementWarning) {
        // eslint-disable-next-line no-console
        console.warn('register-placements (non-fatal):', placementWarning);
      }

      // 3. Tell Bitrix24 the install wizard is finished. CRITICAL STEP.
      //    Per B24 docs, until installFinish() resolves the app is
      //    considered NOT installed: placements don't show up and regular
      //    users see "ask administrator to finish install", while the
      //    admin keeps getting the install page on every open. On success
      //    the SDK reloads the iframe and Bitrix24 reopens the app, so the
      //    code after this usually does not run. We DO NOT swallow a
      //    failure here: if installFinish throws, the install genuinely
      //    did not complete and the admin must see the error rather than a
      //    false "success".
      await installFinishB24();

      return res;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['install', 'status'] });
      // installFinish() above usually reloads the iframe; if the SDK
      // skipped the reload (e.g. dev mode without B24 wrapper),
      // navigate manually as a fallback.
      navigate('/templates', { replace: true });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) setErrorMsg(err.message);
      else if (err instanceof Error) setErrorMsg(err.message);
      else setErrorMsg('Не удалось сохранить настройки');
    },
  });

  /* ------------------------------------------------------------ */
  /* Recovery: our DB says "installed" but Bitrix24 may disagree.   */
  /*                                                                */
  /* If a previous attempt saved settings (DB row created) but      */
  /* never reached installFinish() — e.g. an old build aborted on a */
  /* placement.bind error — Bitrix24 keeps INSTALLED=false and shows */
  /* the install page on every open, while our status endpoint      */
  /* reports installed:true. Detect that mismatch via app.info and  */
  /* re-run installFinish so the portal-side install completes.     */
  /* ------------------------------------------------------------ */
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);

  const finishOnPortal = async () => {
    setRecoverError(null);
    setRecovering(true);
    try {
      // Best-effort: (re)register placements before finishing so the
      // deal-card tab appears. Failures here must not block installFinish.
      try {
        await installApi.registerPlacements({});
      } catch {
        // non-fatal — admin can re-bind in Settings
      }
      await installFinishB24();
      // On success the SDK reloads the iframe; if it doesn't, fall through.
      navigate('/templates', { replace: true });
    } catch (err) {
      setRecoverError(
        err instanceof Error ? err.message : 'Не удалось завершить установку в Bitrix24',
      );
    } finally {
      setRecovering(false);
    }
  };

  // NOTE: automatic portal-side install recovery (our DB says installed
  // but Bitrix24 reports INSTALLED=false) lives in PlacementGuard, which
  // runs on every app open regardless of route — the install handler URL
  // may route straight into the app rather than to /install. Here we only
  // expose a MANUAL "finish install" action via finishOnPortal().

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);

  /* ------------------------------------------------------------ */
  /* Render                                                        */
  /* ------------------------------------------------------------ */
  if (!isB24Available()) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Приложение для Bitrix24</h1>
        <p className="mt-4 text-muted-foreground">
          Это приложение должно быть открыто изнутри портала Bitrix24
          (в iframe). При локальной разработке установите плагин в
          свой dev-портал и откройте его через вкладку сделки.
        </p>
      </div>
    );
  }

  if (statusQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <p className="text-muted-foreground">Проверка статуса установки…</p>
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Ошибка</h1>
        <p className="mt-2 text-destructive">
          Не удалось получить статус установки: {(statusQuery.error as Error).message}
        </p>
      </div>
    );
  }

  if (statusQuery.data?.installed) {
    // Our DB says installed. Two sub-cases:
    //  - Bitrix24 also considers it installed → normal escape hatch.
    //  - Bitrix24 disagrees (INSTALLED=false) → the effect above is
    //    re-running installFinish; show progress / a manual retry so the
    //    admin is never stuck on a dead-end "already installed" screen.
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Приложение уже установлено</h1>
        <p className="mt-2 text-muted-foreground">
          Администраторы: {statusQuery.data.adminUserIds.join(', ')}
        </p>

        {recovering && (
          <p className="mt-4 text-sm text-muted-foreground">
            Завершаем установку на стороне Bitrix24…
          </p>
        )}

        {recoverError && (
          <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            Не удалось завершить установку в Bitrix24: {recoverError}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => navigate('/templates')} disabled={recovering}>
            Перейти к шаблонам
          </Button>
          <Button
            variant="outline"
            onClick={() => void finishOnPortal()}
            disabled={recovering}
          >
            {recovering ? 'Завершение…' : 'Завершить установку в Bitrix24'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Установка приложения</h1>
      <p className="mt-2 text-muted-foreground">
        Выберите сотрудников, которые получат права администратора — они
        смогут загружать шаблоны, редактировать формулы и настраивать
        поле для прикрепления сгенерированных документов.
      </p>

      <div className="mt-6">
        <label className="text-sm font-medium">Поиск сотрудников</label>
        <Input
          className="mt-2"
          placeholder="Начните вводить имя…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="mt-4 rounded-md border bg-card">
        {usersQuery.isLoading && (
          <div className="p-4 text-sm text-muted-foreground">Поиск…</div>
        )}
        {usersQuery.error && (
          <div className="p-4 text-sm text-destructive">
            Ошибка поиска: {(usersQuery.error as Error).message}
          </div>
        )}
        {usersQuery.data && usersQuery.data.users.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">
            Ничего не найдено
          </div>
        )}
        {usersQuery.data && usersQuery.data.users.length > 0 && (
          <ul className="divide-y">
            {usersQuery.data.users.map((user) => {
              const checked = selected.has(user.id);
              return (
                <li
                  key={user.id}
                  className="flex items-center gap-3 p-3 hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    onChange={() => {
                      setSelected((prev) => {
                        const next = new Map(prev);
                        if (checked) next.delete(user.id);
                        else next.set(user.id, user);
                        return next;
                      });
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{user.fullName}</div>
                    {user.email && (
                      <div className="text-xs text-muted-foreground">
                        {user.email}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">#{user.id}</div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selectedList.length > 0 && (
        <div className="mt-4">
          <div className="text-sm font-medium">
            Выбрано: {selectedList.length}
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {selectedList.map((u) => (
              <li
                key={u.id}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
              >
                {u.fullName}
                <button
                  type="button"
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev);
                      next.delete(u.id);
                      return next;
                    })
                  }
                  aria-label={`Убрать ${u.fullName}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {errorMsg && (
        <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {errorMsg}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button
          disabled={selectedList.length === 0 || saveMutation.isPending}
          onClick={() => {
            setErrorMsg(null);
            saveMutation.mutate(selectedList.map((u) => u.id));
          }}
        >
          {saveMutation.isPending ? 'Сохранение…' : 'Сохранить и продолжить'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Админы смогут добавить ещё участников позже в настройках.
        </span>
      </div>
    </div>
  );
}
