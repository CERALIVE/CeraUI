/**
 * Whether the Live screen's preview disclosure is open. `PreviewDisclosure` owns
 * the value; the layout controls read it to say where the second input is
 * placed, since the designer only renders over an open preview.
 */
export const previewDisclosure = $state({ open: false });
