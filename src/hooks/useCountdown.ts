import { useState, useEffect, useCallback, useRef } from 'react'

interface UseCountdownOptions {
  initialTime: number
  onTick?: (timeLeft: number) => void
  onComplete?: () => void
  autoStart?: boolean
}

export function useCountdown({
  initialTime,
  onTick,
  onComplete,
  autoStart = false,
}: UseCountdownOptions) {
  const [timeLeft, setTimeLeft] = useState(initialTime)
  const [isRunning, setIsRunning] = useState(autoStart)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onTickRef = useRef(onTick)
  const onCompleteRef = useRef(onComplete)

  onTickRef.current = onTick
  onCompleteRef.current = onComplete

  // autoStart prop 또는 initialTime 변경 시 타이머 반응형 동기화
  useEffect(() => {
    if (autoStart) {
      setTimeLeft(initialTime)
      setIsRunning(true)
    } else {
      setIsRunning(false)
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [autoStart, initialTime])

  const start = useCallback(() => {
    setTimeLeft(initialTime)
    setIsRunning(true)
  }, [initialTime])

  const stop = useCallback(() => {
    setIsRunning(false)
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    stop()
    setTimeLeft(initialTime)
  }, [initialTime, stop])

  useEffect(() => {
    if (!isRunning) return

    intervalRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        const next = prev - 1
        onTickRef.current?.(next)

        if (next <= 0) {
          setIsRunning(false)
          onCompleteRef.current?.()
          return 0
        }
        return next
      })
    }, 1000)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [isRunning])

  return { timeLeft, isRunning, start, stop, reset }
}
