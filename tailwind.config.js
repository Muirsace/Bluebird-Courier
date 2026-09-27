/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      /**
       * 语义色：值都指向 styles.css 里的 CSS 变量（RGB 通道三元组），
       * 所以组件写 bg-surface / text-muted，具体是深色还是浅色由 [data-theme] 决定。
       * 用法见 docs/ui-ux/refactor-plan.md 的 Phase 6。
       */
      colors: {
        app: 'rgb(var(--color-app) / <alpha-value>)',

        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          raised: 'rgb(var(--color-surface-raised) / <alpha-value>)',
          hover: 'rgb(var(--color-surface-hover) / <alpha-value>)',
          active: 'rgb(var(--color-surface-active) / <alpha-value>)',
        },

        default: 'rgb(var(--color-border) / <alpha-value>)',
        subtle: 'rgb(var(--color-border-subtle) / <alpha-value>)',
        strong: 'rgb(var(--color-border-strong) / <alpha-value>)',

        primary: 'rgb(var(--color-text) / <alpha-value>)',
        secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
        muted: 'rgb(var(--color-text-muted) / <alpha-value>)',

        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)',
          soft: 'rgb(var(--color-accent-soft) / <alpha-value>)',
          solid: 'rgb(var(--color-accent-solid) / <alpha-value>)',
          'solid-hover': 'rgb(var(--color-accent-solid-hover) / <alpha-value>)',
          contrast: 'rgb(var(--color-accent-contrast) / <alpha-value>)',
        },

        success: {
          DEFAULT: 'rgb(var(--color-success) / <alpha-value>)',
          soft: 'rgb(var(--color-success-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--color-warning) / <alpha-value>)',
          soft: 'rgb(var(--color-warning-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--color-danger) / <alpha-value>)',
          soft: 'rgb(var(--color-danger-soft) / <alpha-value>)',
          solid: 'rgb(var(--color-danger-solid) / <alpha-value>)',
          'solid-hover': 'rgb(var(--color-danger-solid-hover) / <alpha-value>)',
          contrast: 'rgb(var(--color-danger-contrast) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--color-info) / <alpha-value>)',
          soft: 'rgb(var(--color-info-soft) / <alpha-value>)',
        },

        // Chart.js 用完整色值（不能是通道三元组），只经 ChartPalette 读取
        chart: {
          grid: 'var(--chart-grid)',
          label: 'var(--chart-label)',
          tooltip: 'var(--chart-tooltip)',
          'tooltip-text': 'var(--chart-tooltip-text)',
          star: 'var(--chart-star)',
          fork: 'var(--chart-fork)',
        },
      },
    },
  },
  plugins: [],
};
