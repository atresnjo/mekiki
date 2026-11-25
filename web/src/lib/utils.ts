import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** shadcn's class joiner, which the mebius chart components import */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
