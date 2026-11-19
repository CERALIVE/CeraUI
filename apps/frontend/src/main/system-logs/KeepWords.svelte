<!--
  KeepWords.svelte: fixed translated copy that may wrap in the Downloads rows,
  the Sharing group and its dialogs, and the Raw logs approximate and unknown-moment notes; never a user-supplied value such as a name
  or a version. In Chinese it marks the gaps between words with <wbr> (`chineseWordChunks`), and
  the owner's `[&:lang(zh)]:break-keep` lets a line break only there and at
  punctuation. Every other locale, and a browser without `Intl.Segmenter`,
  renders the copy as one text node.
-->
<script lang="ts">
import { getLocale } from '@ceraui/i18n/svelte';

import { chineseWordChunks } from '$lib/device-logs/cjk-words';

let { text }: { text: string } = $props();

const chunks = $derived(chineseWordChunks(text, getLocale()));
</script>

{#each chunks as chunk, index (index)}{#if index > 0}<wbr />{/if}{chunk}{/each}
