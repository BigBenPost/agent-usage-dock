/** The Google Gemini sparkle icon as inline SVG, for the dashboard heading. */
export const GEMINI_ICON = '<svg class="brand" role="img" aria-label="Google Gemini" viewBox="0 0 296 298" fill="none"><path fill="url(#gemini-grad)" d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"/><defs><linearGradient id="gemini-grad" x1="0" y1="0" x2="296" y2="298" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4E82EE"/><stop offset="50%" stop-color="#9B72CF"/><stop offset="100%" stop-color="#D96570"/></linearGradient></defs></svg>';

/** Author metadata and the dashboard contact address. */
export const AUTHOR_NAME = 'zhang.xijue';
export const CONTACT_EMAIL = 'zhang.xijue@u.nus.edu';

/** The Gemini sparkle as a status bar icon. The glyph is declared in package.json under `contributes.icons` and drawn from `media/gemini.woff`, so it takes the text colour of the item. */
export const STATUS_BAR_ICON = '$(agy-gemini)';

/**
 * The budget level as a colour glyph of the icon font (see tools/build-icon-font.py): a ring with a dot for after the text, or a bar for in
 * front of the mark. The editor draws them in their own colour while the text and the mark keep the item's text colour, so one status bar item
 * can show both. The key is the colour for the level.
 */
export const LEVEL_RING_ICONS = { green: '$(agy-ring-ok)', amber: '$(agy-ring-warning)', red: '$(agy-ring-critical)' } as const;
export const LEVEL_BAR_ICONS = { green: '$(agy-bar-ok)', amber: '$(agy-bar-warning)', red: '$(agy-bar-critical)' } as const;
