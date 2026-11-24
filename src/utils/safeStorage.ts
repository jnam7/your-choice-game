export const safeStorage = {
  getItem: (key: string): string | null => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key)
      }
    } catch (e) {
      console.warn(`[safeStorage.getItem error for ${key}]`, e)
    }
    return null
  },

  setItem: (key: string, value: string): void => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value)
      }
    } catch (e) {
      console.warn(`[safeStorage.setItem error for ${key}]`, e)
    }
  },

  removeItem: (key: string): void => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key)
      }
    } catch (e) {
      console.warn(`[safeStorage.removeItem error for ${key}]`, e)
    }
  },

  getJSON: <T>(key: string, fallback: T): T => {
    try {
      const val = safeStorage.getItem(key)
      if (val) {
        const parsed = JSON.parse(val)
        return parsed !== null && parsed !== undefined ? parsed : fallback
      }
    } catch (e) { }
    return fallback
  },

  clear: (): void => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.clear()
      }
    } catch (e) { }
  },
}

