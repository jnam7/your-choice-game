// Firebase 완전 비활성화: useSocketSync로 완전 대체
import { useSocketSync } from './useSocketSync'

export function useFirebaseSync() {
  useSocketSync()
}
