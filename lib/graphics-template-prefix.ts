// Base name of the Lottie overlay templates in the templates bucket. Each
// aspect ratio's key is `templates/<prefix>-<width>x<height>-<w>x<h>.json`.
// The default is the reference template that LottieTemplatesDeployment
// uploads from graphics/templates/. A customer template gets its own prefix
// so it never sits under keys the bucket deployment owns.
export const DEFAULT_GRAPHICS_TEMPLATE_PREFIX = 'graphics-overlay';

// One S3 key segment: letters, digits, '.', '_' and '-', starting with a
// letter or digit. No '/', no spaces, no '..'.
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function resolveGraphicsTemplatePrefix(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (value === '') return DEFAULT_GRAPHICS_TEMPLATE_PREFIX;
  if (!PREFIX_PATTERN.test(value) || value.includes('..')) {
    throw new Error(
      `GraphicsTemplatePrefix ${JSON.stringify(value)} is not a valid template name. ` +
      'Use 1-100 letters, digits, ".", "_" or "-", starting with a letter or digit, ' +
      'with no "/" or "..", e.g. "graphics-overlay" or "sinclair-demo".');
  }
  return value;
}
