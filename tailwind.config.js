/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#0B1426',
          light: '#162040',
          lighter: '#1E2D50',
          dark: '#060B15',
        },
        gold: {
          DEFAULT: '#FFD700',
          dark: '#CC9900',
          light: '#FFE55C',
        },
        'team-a': {
          DEFAULT: '#EF4444',
          dark: '#B91C1C',
          light: '#FCA5A5',
          glow: 'rgba(239, 68, 68, 0.4)',
        },
        'team-b': {
          DEFAULT: '#3B82F6',
          dark: '#1D4ED8',
          light: '#93C5FD',
          glow: 'rgba(59, 130, 246, 0.4)',
        },
      },
      fontFamily: {
        display: ['"Black Han Sans"', 'sans-serif'],
        body: ['"Noto Sans KR"', 'sans-serif'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'pulse-glow-red': 'pulse-glow-red 2s ease-in-out infinite',
        'pulse-glow-blue': 'pulse-glow-blue 2s ease-in-out infinite',
        'countdown-urgent': 'countdown-urgent 0.5s ease-in-out infinite',
        'slide-up': 'slide-up 0.6s ease-out',
        'slide-down': 'slide-down 0.6s ease-out',
        'fade-in': 'fade-in 0.5s ease-out',
        'scale-in': 'scale-in 0.3s ease-out',
        'bounce-in': 'bounce-in 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        'float': 'float 3s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 20px rgba(255, 215, 0, 0.3)' },
          '50%': { boxShadow: '0 0 40px rgba(255, 215, 0, 0.6), 0 0 80px rgba(255, 215, 0, 0.2)' },
        },
        'pulse-glow-red': {
          '0%, 100%': { boxShadow: '0 0 20px rgba(239, 68, 68, 0.3)' },
          '50%': { boxShadow: '0 0 40px rgba(239, 68, 68, 0.6), 0 0 80px rgba(239, 68, 68, 0.2)' },
        },
        'pulse-glow-blue': {
          '0%, 100%': { boxShadow: '0 0 20px rgba(59, 130, 246, 0.3)' },
          '50%': { boxShadow: '0 0 40px rgba(59, 130, 246, 0.6), 0 0 80px rgba(59, 130, 246, 0.2)' },
        },
        'countdown-urgent': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.2)' },
        },
        'slide-up': {
          from: { transform: 'translateY(30px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'slide-down': {
          from: { transform: 'translateY(-30px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { transform: 'scale(0.8)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        'bounce-in': {
          '0%': { transform: 'scale(0.3)', opacity: '0' },
          '50%': { transform: 'scale(1.08)' },
          '70%': { transform: 'scale(0.92)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
