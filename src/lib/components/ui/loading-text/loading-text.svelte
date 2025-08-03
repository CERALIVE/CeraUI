<script lang="ts">
import { cn } from '$lib/utils';

type LoadingVariant = 'default' | 'sm' | 'lg' | 'fast' | 'slow';
type LoadingSize = 'sm' | 'base' | 'lg';
type LoadingStyle = 'default' | 'pulse' | 'shimmer';
type LoadingColor = 'default' | 'success' | 'warning' | 'error' | 'info';

interface Props {
  variant?: LoadingVariant;
  size?: LoadingSize;
  style?: LoadingStyle;
  color?: LoadingColor;
  class?: string;
  dotClass?: string;
  showDots?: boolean;
}

let {
  variant = 'default',
  size = 'base',
  style = 'default',
  color = 'default',
  class: className,
  dotClass,
  showDots = true,
  children
}: Props = $props();

const getLoadingClass = (variant: LoadingVariant, color: LoadingColor) => {
  const baseClass = 'loading';
  const variantClass = variant === 'default' ? baseClass : `${baseClass}-${variant}`;
  const colorClass = color === 'default' ? '' : `loading-${color}`;
  return cn(variantClass, colorClass);
};

const getSizeClasses = (size: LoadingSize) => {
  switch (size) {
    case 'sm':
      return 'text-sm';
    case 'lg':
      return 'text-lg';
    default:
      return 'text-base';
  }
};

const getStyleClasses = (style: LoadingStyle) => {
  switch (style) {
    case 'pulse':
      return 'loading-pulse';
    case 'shimmer':
      return 'loading-shimmer';
    default:
      return '';
  }
};
</script>

<div
  class={cn(
    'inline-flex items-center gap-1.5 transition-all duration-200',
    getSizeClasses(size),
    getStyleClasses(style),
    className
  )}
  role="status"
  aria-live="polite">
  
  <span class="leading-tight font-medium">
    {@render children()}
  </span>
  
  {#if showDots}
    <span
      class={cn(
        getLoadingClass(variant, color),
        'shrink-0 select-none opacity-80',
        dotClass
      )}
      aria-hidden="true">
    </span>
  {/if}
</div>