import ArrowRight from 'lucide-svelte/icons/arrow-right';
import Check from 'lucide-svelte/icons/check';
import ChevronLeft from 'lucide-svelte/icons/chevron-left';
import ChevronRight from 'lucide-svelte/icons/chevron-right';
import CircleHelp from 'lucide-svelte/icons/circle-help';
import ClipboardCheck from 'lucide-svelte/icons/clipboard-check';
import Copy from 'lucide-svelte/icons/copy';
import CreditCard from 'lucide-svelte/icons/credit-card';
import EllipsisVertical from 'lucide-svelte/icons/ellipsis';
import File from 'lucide-svelte/icons/file';
import FileText from 'lucide-svelte/icons/file-text';
import Image from 'lucide-svelte/icons/image';
import Laptop from 'lucide-svelte/icons/laptop';
import LoaderCircle from 'lucide-svelte/icons/loader-circle';
import Moon from 'lucide-svelte/icons/moon';
import Pizza from 'lucide-svelte/icons/pizza';
import Plus from 'lucide-svelte/icons/plus';
import Settings from 'lucide-svelte/icons/settings';
import SunMedium from 'lucide-svelte/icons/sun-medium';
import Trash from 'lucide-svelte/icons/trash';
import TriangleAlert from 'lucide-svelte/icons/triangle-alert';
import User from 'lucide-svelte/icons/user';
import X from 'lucide-svelte/icons/x';
import type { SvelteComponent } from 'svelte';

import Hamburger from './hamburger.svelte';
import Logo from './logo.svelte';

export type Icon = SvelteComponent;

export const Icons = {
  logo: Logo,
  close: X,
  spinner: LoaderCircle,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  trash: Trash,
  post: FileText,
  page: File,
  media: Image,
  settings: Settings,
  billing: CreditCard,
  ellipsis: EllipsisVertical,
  add: Plus,
  warning: TriangleAlert,
  user: User,
  arrowRight: ArrowRight,
  help: CircleHelp,
  pizza: Pizza,
  check: Check,
  copy: Copy,
  copyDone: ClipboardCheck,
  sun: SunMedium,
  moon: Moon,
  laptop: Laptop,
  Hamburger,
};
