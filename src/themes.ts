export const themes = {
  light: { label: "Light", mode: "light", surface: "#ffffff", accent: "#277e61" },
  dark: { label: "Dark", mode: "dark", surface: "#171c23", accent: "#9ce3bb" },
  "catppuccin-latte": { label: "Latte", mode: "light", surface: "#eff1f5", accent: "#8839ef" },
  "catppuccin-frappe": { label: "Frappé", mode: "dark", surface: "#303446", accent: "#ca9ee6" },
  "catppuccin-macchiato": { label: "Macchiato", mode: "dark", surface: "#24273a", accent: "#c6a0f6" },
  "catppuccin-mocha": { label: "Mocha", mode: "dark", surface: "#1e1e2e", accent: "#cba6f7" },
  "rose-pine-main": { label: "Main", mode: "dark", surface: "#1f1d2e", accent: "#ebbcba" },
  "rose-pine-moon": { label: "Moon", mode: "dark", surface: "#2a273f", accent: "#ea9a97" },
  "rose-pine-dawn": { label: "Dawn", mode: "light", surface: "#fffaf3", accent: "#a9546b" },
  "tokyo-night-storm": { label: "Storm", mode: "dark", surface: "#24283b", accent: "#7aa2f7" },
  "tokyo-night-moon": { label: "Moon", mode: "dark", surface: "#222436", accent: "#82aaff" },
  "tokyo-night-night": { label: "Night", mode: "dark", surface: "#1a1b26", accent: "#7aa2f7" },
  "tokyo-night-day": { label: "Day", mode: "light", surface: "#e1e2e7", accent: "#2e7de9" },
  "monokai-classic": { label: "Classic", mode: "dark", surface: "#272822", accent: "#a6e22e" },
  "monokai-pro": { label: "Pro", mode: "dark", surface: "#2d2a2e", accent: "#a9dc76" },
  "monokai-machine": { label: "Machine", mode: "dark", surface: "#273136", accent: "#a2e57b" },
  "monokai-octagon": { label: "Octagon", mode: "dark", surface: "#282a3a", accent: "#bad761" },
  "monokai-ristretto": { label: "Ristretto", mode: "dark", surface: "#2c2525", accent: "#adda78" },
  "monokai-spectrum": { label: "Spectrum", mode: "dark", surface: "#222222", accent: "#7bd88f" },
  "github-light": { label: "Light", mode: "light", surface: "#ffffff", accent: "#0969da" },
  "github-light-high-contrast": { label: "Light High Contrast", mode: "light", surface: "#ffffff", accent: "#0349b4" },
  "github-dark": { label: "Dark", mode: "dark", surface: "#161b22", accent: "#58a6ff" },
  "github-dark-dimmed": { label: "Dark Dimmed", mode: "dark", surface: "#2d333b", accent: "#539bf5" },
  "github-dark-high-contrast": { label: "Dark High Contrast", mode: "dark", surface: "#0d1117", accent: "#79c0ff" },
} as const;

export type ThemeId = keyof typeof themes;

export const themeGroups: { label: string; options: ThemeId[] }[] = [
  { label: "Kodama", options: ["light", "dark"] },
  { label: "Catppuccin", options: ["catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha"] },
  { label: "Rosé Pine", options: ["rose-pine-main", "rose-pine-moon", "rose-pine-dawn"] },
  { label: "Tokyo Night", options: ["tokyo-night-storm", "tokyo-night-moon", "tokyo-night-night", "tokyo-night-day"] },
  { label: "Monokai", options: ["monokai-classic", "monokai-pro", "monokai-machine", "monokai-octagon", "monokai-ristretto", "monokai-spectrum"] },
  { label: "GitHub", options: ["github-light", "github-dark", "github-dark-dimmed", "github-light-high-contrast", "github-dark-high-contrast"] },
];

export function savedTheme(value: string | null): ThemeId {
  if (value === "github-light-colorblind" || value === "github-light-tritanopia") return "github-light";
  if (value === "github-dark-colorblind" || value === "github-dark-tritanopia") return "github-dark";
  return value && Object.prototype.hasOwnProperty.call(themes, value) ? value as ThemeId : "dark";
}
