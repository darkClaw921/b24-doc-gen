/**
 * `<Toaster>` is the host component that renders every toast queued
 * by the `toast()` helper / `useToast()` hook.
 *
 * Mount it once near the root of the app (see `App.tsx`). It is wrapped
 * in `<ToastProvider>` so the Radix portal/viewport are available, and
 * iterates the current toast queue from `useToast()` to render each one.
 */

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';
import { useToast } from './use-toast';

export function Toaster(): JSX.Element {
  const { toasts } = useToast();

  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(({ id, title, description, action, ...props }) => (
        <Toast key={id} {...props}>
          <div className="grid gap-1">
            {title ? <ToastTitle>{title}</ToastTitle> : null}
            {description ? <ToastDescription>{description}</ToastDescription> : null}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
