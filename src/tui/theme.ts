import { parseColor } from "@opentui/core";

import { theme, tint } from "../components/ui/theme";
import { cobaltDeep } from "../themes/cobalt-deep";

theme.register("cobalt-deep", cobaltDeep);
theme.setActive("cobalt-deep");
theme.setMode("dark");
theme.override({
  borders: { style: "rounded" },
  density: { paddingX: 1, comfortablePaddingX: 2 },
});

const colors = theme.get().colors;

export const tuiTheme = {
  background: colors.background,
  panel: colors.surface,
  element: tint(colors.surface, colors.foreground, 0.05),
  elementFocused: tint(colors.surface, colors.focus, 0.14),
  border: colors.border,
  borderActive: tint(colors.border, colors.focus, 0.35),
  text: colors.foreground,
  muted: colors.mutedForeground,
  primary: colors.primary,
  selectedText: colors.primaryForeground,
  destructive: colors.destructive,
  destructiveText: colors.destructiveForeground,
  success: colors.success,
  successText: colors.successForeground,
  warning: colors.warning,
  warningText: colors.warningForeground,
  connected: tint(colors.background, colors.success, 0.16),
  disconnected: tint(colors.background, colors.destructive, 0.12),
} as const;

export const chromeForeground = parseColor(tuiTheme.text);
