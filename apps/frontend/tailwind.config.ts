import type { Config } from "tailwindcss";
import { fontFamily } from "tailwindcss/defaultTheme";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
	darkMode: ["class"],
	content: ["./src/**/*.{html,js,svelte,ts}"],
	safelist: ["dark"],
	theme: {
		container: {
			center: true,
			padding: "2rem",
			screens: {
				"2xl": "1400px",
			},
		},
		extend: {
			colors: {
				border: "var(--border)",
				input: "var(--input)",
				ring: "var(--ring)",
				background: "var(--background)",
				foreground: "var(--foreground)",
				primary: {
					DEFAULT: "var(--primary)",
					foreground: "var(--primary-foreground)",
				},
				secondary: {
					DEFAULT: "var(--secondary)",
					foreground: "var(--secondary-foreground)",
				},
				destructive: {
					DEFAULT: "var(--destructive)",
					foreground: "var(--destructive-foreground)",
				},
				muted: {
					DEFAULT: "var(--muted)",
					foreground: "var(--muted-foreground)",
				},
				accent: {
					DEFAULT: "var(--accent)",
					foreground: "var(--accent-foreground)",
				},
				popover: {
					DEFAULT: "var(--popover)",
					foreground: "var(--popover-foreground)",
				},
				card: {
					DEFAULT: "var(--card)",
					foreground: "var(--card-foreground)",
				},
				sidebar: {
					DEFAULT: "var(--sidebar-background)",
					foreground: "var(--sidebar-foreground)",
					primary: "var(--sidebar-primary)",
					"primary-foreground": "var(--sidebar-primary-foreground)",
					accent: "var(--sidebar-accent)",
					"accent-foreground": "var(--sidebar-accent-foreground)",
					border: "var(--sidebar-border)",
					ring: "var(--sidebar-ring)",
				},
				status: {
					success: {
						DEFAULT: "var(--status-success)",
						foreground: "var(--status-success-foreground)",
					},
					info: {
						DEFAULT: "var(--status-info)",
						foreground: "var(--status-info-foreground)",
					},
					warning: {
						DEFAULT: "var(--status-warning)",
						foreground: "var(--status-warning-foreground)",
					},
					error: {
						DEFAULT: "var(--status-error)",
						foreground: "var(--status-error-foreground)",
					},
					neutral: {
						DEFAULT: "var(--status-neutral)",
						foreground: "var(--status-neutral-foreground)",
					},
				},
				signal: {
					excellent: "var(--signal-excellent)",
					good: "var(--signal-good)",
					fair: "var(--signal-fair)",
					weak: "var(--signal-weak)",
				},
				switch: {
					off: "var(--switch-off)",
					"off-foreground": "var(--switch-off-foreground)",
				},
			},
			borderRadius: {
				xl: "calc(var(--radius) + 4px)",
				lg: "var(--radius)",
				md: "calc(var(--radius) - 2px)",
				sm: "calc(var(--radius) - 4px)",
			},
			fontFamily: {
				sans: [
					"Space Grotesk Variable",
					"Space Grotesk",
					// CJK system fallbacks (Space Grotesk has no CJK glyphs)
					'"Noto Sans CJK SC"',
					'"Microsoft YaHei"',
					'"Hiragino Sans"',
					'"Noto Sans JP"',
					'"Noto Sans KR"',
					// Arabic system fallback
					'"Noto Sans Arabic"',
					"Tahoma",
					"system-ui",
					"sans-serif",
				],
				mono: ["JetBrains Mono Variable", ...fontFamily.mono],
			},
			keyframes: {
				"accordion-down": {
					from: { height: "0" },
					to: { height: "var(--bits-accordion-content-height)" },
				},
				"accordion-up": {
					from: { height: "var(--bits-accordion-content-height)" },
					to: { height: "0" },
				},
				"caret-blink": {
					"0%,70%,100%": { opacity: "1" },
					"20%,50%": { opacity: "0" },
				},
			},
			animation: {
				"accordion-down": "accordion-down 0.2s ease-out",
				"accordion-up": "accordion-up 0.2s ease-out",
				"caret-blink": "caret-blink 1.25s ease-out infinite",
			},
		},
	},
	plugins: [tailwindcssAnimate],
};

export default config;
