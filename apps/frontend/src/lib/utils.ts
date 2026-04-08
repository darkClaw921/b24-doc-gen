import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility to merge Tailwind classes while deduplicating conflicts.
 * Used across all shadcn/ui components.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
