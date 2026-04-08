/**
 * Lightweight `useToast` hook (shadcn/ui style) backed by an in-memory
 * store. Components call `toast({ title, description, variant })` to
 * push a toast onto the queue; the `<Toaster>` component subscribes
 * via `useToast()` and renders them.
 *
 * Inspired by the standard shadcn `use-toast.ts` recipe — kept tiny
 * (no useReducer ceremony, just a single mutable state + listeners).
 */

import * as React from 'react';
import type { ToastActionElement, ToastProps } from './toast';

const TOAST_LIMIT = 5;
const TOAST_REMOVE_DELAY = 5_000;

type ToasterToast = Omit<ToastProps, 'title'> & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

interface State {
  toasts: ToasterToast[];
}

let listeners: Array<(state: State) => void> = [];
let memoryState: State = { toasts: [] };

function notify(): void {
  for (const listener of listeners) listener(memoryState);
}

function setState(updater: (s: State) => State): void {
  memoryState = updater(memoryState);
  notify();
}

let idCounter = 0;
function nextId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return idCounter.toString(36);
}

interface ToastInput {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: 'default' | 'destructive';
  duration?: number;
  action?: ToastActionElement;
}

/** Imperative entry point — usable from outside React (e.g. fetch handlers). */
export function toast(input: ToastInput): { id: string; dismiss: () => void } {
  const id = nextId();
  const duration = input.duration ?? TOAST_REMOVE_DELAY;
  const item: ToasterToast = {
    id,
    title: input.title,
    description: input.description,
    variant: input.variant ?? 'default',
    action: input.action,
    open: true,
    onOpenChange: (open) => {
      if (!open) dismiss(id);
    },
  };
  setState((s) => ({ toasts: [item, ...s.toasts].slice(0, TOAST_LIMIT) }));
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return { id, dismiss: () => dismiss(id) };
}

export function dismiss(id: string): void {
  setState((s) => ({
    toasts: s.toasts.map((t) => (t.id === id ? { ...t, open: false } : t)),
  }));
  // Remove fully after the close animation finishes.
  setTimeout(() => {
    setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, 300);
}

/** React hook returning the current toast queue + helpers. */
export function useToast(): {
  toasts: ToasterToast[];
  toast: typeof toast;
  dismiss: typeof dismiss;
} {
  const [state, setLocalState] = React.useState<State>(memoryState);
  React.useEffect(() => {
    listeners.push(setLocalState);
    return () => {
      listeners = listeners.filter((l) => l !== setLocalState);
    };
  }, []);
  return { toasts: state.toasts, toast, dismiss };
}
