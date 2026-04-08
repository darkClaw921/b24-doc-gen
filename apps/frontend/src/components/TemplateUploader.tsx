/**
 * TemplateUploader — drag&drop upload zone for `.docx` files.
 *
 * Used by the templates page when an admin wants to import a Word
 * document as a new template. The component is intentionally
 * stateless about which theme the upload belongs to — the parent
 * supplies a `themeId` prop.
 *
 * Behaviour:
 *  1. Renders a dashed dropzone (built on `react-dropzone`) that
 *     accepts a single `.docx` file up to 20 MB.
 *  2. When the user drops or selects a file we POST it to
 *     `/api/templates/upload` via `templatesApi.upload`, which
 *     reports XHR upload progress.
 *  3. While uploading we display a progress bar and disable the zone.
 *  4. On success we call `onSuccess(template.id)` so the parent can
 *     navigate to the editor.
 *  5. On error we surface a friendly message via the `onError`
 *     callback or in-component banner.
 *
 * Validation rules:
 *   - Accepts only `.docx` (extension + MIME type).
 *   - Max size 20 MB (matches the backend limit).
 */

import { useCallback, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { UploadCloud, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { ApiError, templatesApi, type TemplateDTO } from '@/lib/api';
import { cn } from '@/lib/utils';

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const ACCEPT_MIME = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};

export interface TemplateUploaderProps {
  /** Theme the new template should be attached to. Required. */
  themeId: string;
  /** Optional initial name suggestion (defaults to the filename). */
  defaultName?: string;
  /** Called with the created template (or just its id) on success. */
  onSuccess?: (template: TemplateDTO) => void;
  /** Optional error sink. When omitted the component shows the error inline. */
  onError?: (message: string) => void;
  /** Extra wrapper class. */
  className?: string;
}

export function TemplateUploader({
  themeId,
  defaultName,
  onSuccess,
  onError,
  className,
}: TemplateUploaderProps) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState<File | null>(null);

  const handleError = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  const startUpload = useCallback(
    async (file: File) => {
      if (!themeId) {
        handleError('Сначала выберите тему');
        return;
      }
      setError(null);
      setProgress(0);
      setUploadingFile(file);
      try {
        const baseName = (defaultName ?? file.name.replace(/\.docx$/i, '')).trim();
        const name = baseName.length > 0 ? baseName : 'Без имени';
        const result = await templatesApi.upload(
          { name, themeId, file },
          {
            onProgress: (loaded, total) => {
              if (total > 0) {
                setProgress(Math.round((loaded / total) * 100));
              }
            },
          },
        );
        setProgress(100);
        onSuccess?.(result.template);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? `${err.message} (${err.status || 'network'})`
            : err instanceof Error
              ? err.message
              : 'Не удалось загрузить файл';
        handleError(message);
      } finally {
        setUploadingFile(null);
        // Keep progress visible for a beat so the user sees 100% on success.
        setTimeout(() => setProgress(null), 600);
      }
    },
    [defaultName, handleError, onSuccess, themeId],
  );

  const onDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      if (rejected.length > 0) {
        const firstError = rejected[0]?.errors[0];
        if (firstError?.code === 'file-too-large') {
          handleError('Файл больше 20 МБ');
        } else if (firstError?.code === 'file-invalid-type') {
          handleError('Поддерживаются только файлы .docx');
        } else {
          handleError(firstError?.message ?? 'Файл отклонён');
        }
        return;
      }
      const file = accepted[0];
      if (!file) return;
      void startUpload(file);
    },
    [handleError, startUpload],
  );

  const { getRootProps, getInputProps, isDragActive, isDragAccept, isDragReject } =
    useDropzone({
      onDrop,
      accept: ACCEPT_MIME,
      maxSize: MAX_SIZE_BYTES,
      multiple: false,
      disabled: progress !== null,
    });

  const isUploading = progress !== null && progress < 100;

  return (
    <div className={cn('space-y-3', className)}>
      <div
        {...getRootProps()}
        className={cn(
          'relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-input bg-muted/30 px-6 py-10 text-center transition-colors',
          isDragActive && 'bg-muted/60',
          isDragAccept && 'border-primary',
          isDragReject && 'border-destructive',
          progress !== null && 'pointer-events-none opacity-80',
        )}
      >
        <input {...getInputProps()} />
        {uploadingFile ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm font-medium">Загружаем «{uploadingFile.name}»…</div>
          </>
        ) : (
          <>
            <UploadCloud className="h-10 w-10 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">
                Перетащите .docx сюда или нажмите для выбора
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Один файл, до 20 МБ
              </div>
            </div>
          </>
        )}
      </div>

      {progress !== null && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              {uploadingFile?.name ?? 'Готово'}
            </span>
            <span>{progress}%</span>
          </div>
        </div>
      )}

      {error && !isUploading && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
