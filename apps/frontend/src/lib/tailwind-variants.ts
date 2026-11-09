import { twMerge } from "tailwind-merge";
import { createTV } from "tailwind-variants/lite";

export type { VariantProps } from "tailwind-variants/lite";

// Share cn's merger without changing the generated shadcn recipes.
export const tv = createTV({ twMerge });
