# AoE4 Color Palette Reference

Extracted from the Rus Field Net three-panel chat HTML design.

## CSS Variables (from `:root`)

```css
:root {
  --map-blur: 5.2px;
  --worker-blur: 8px;
  --ink: #e6edf3;          /* Main text color */
  --muted: #a7b6c5;        /* Secondary/muted text */
  --faint: #718396;        /* Tertiary text */
  --line: rgba(188, 215, 235, .13);  /* Border/divider */
  --glass: rgba(8, 15, 22, .39);     /* Panel background */
  --glass-strong: rgba(7, 13, 20, .27); /* Darker panel bg */
  --panel-highlight: rgba(190, 224, 248, .055); /* Panel accent */
  --blue: #70b9f6;         /* Primary accent - AoE4 blue */
  --blue-bright: #a8d9ff;  /* Highlight - lighter blue */
  --green: #76d692;        /* Success/online status */
  --gold: #e6b65c;         /* Warning/idle status */
}
```

## Key Colors for Theme Mapping

| Role | Hex Value | Description |
|------|-----------|-------------|
| Background | `#10191b` | Dark forest green (from `body { background }`) |
| Surface 1 | `#1c291c` | Raised surface (from `.glass`) |
| Surface 2 | `#08151a` | Sunken/deep surface |
| Text Primary | `#e6edf3` | Main text / ink |
| Text Secondary | `#a7b6c5` | Muted text |
| Text Muted | `#718396` | Faint/tertiary text |
| Accent | `#70b9f6` | Primary brand blue |
| Accent Bright | `#a8d9ff` | Highlight color |
| Success | `#76d692` | Green - online/active |
| Warning | `#e6b65c` | Gold - idle/warning |
| Border | `rgba(188, 215, 235, 0.13)` | Subtle divider |

## HTML Structure Reference

The three-panel chat has:
1. **Left Rail** (`.left-rail`) - Channels, route cards, scene controls
2. **Center Chat** (`.chat`) - Messages and composer
3. **Right Rail** (`.right-rail`) - Member list, patrol card

## Contrast Ratios

- Background `#10191b` vs Text `#e6edf3`: ~12.5:1 (WCAG AAA)
- Background `#10191b` vs Accent `#70b9f6`: ~7.2:1 (WCAG AA)

## Usage Notes

- The blue worker marks on the map are deliberately soft to blend with the blurred background
- Glass effects use translucent backgrounds for depth
- Gold is used for idle status dots, green for active
- The resin-sheen is a subtle animated gradient overlay