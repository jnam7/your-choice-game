import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useGameStore } from '../store/gameStore'

export function LiveChatDrawer() {
  const [isOpen, setIsOpen] = useState(false)
  const [text, setText] = useState('')
  const { chatMessages, sendChatMessage, currentPlayerId } = useGameStore()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const quickReactions = ['A 가자! 🔥', 'B 가자! 🚀', '살았다! 🎉', '아 탈락 ㅠㅠ 💀', 'ㅋㅋㅋ', '대박']

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!text.trim()) return
    sendChatMessage(text)
    setText('')
  }

  const handleQuickReaction = (reaction: string) => {
    sendChatMessage(reaction)
  }

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages, isOpen])

  return (
    <>
      {/* 플로팅 채팅 열기 버튼 */}
      <motion.button
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-5 right-5 z-40 px-4 py-2.5 bg-gradient-to-r from-gold-dark to-gold text-navy-dark rounded-full font-bold shadow-2xl flex items-center gap-2 border-2 border-white/30 text-sm"
      >
        <span className="text-base">💬</span>
        <span>실시간 응원</span>
        {chatMessages.length > 0 && (
          <span className="px-1.5 py-0.2 bg-navy-dark text-gold text-xs rounded-full font-mono">
            {chatMessages.length}
          </span>
        )}
      </motion.button>

      {/* 모바일 하단 슬라이드업 채팅 창 */}
      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center pointer-events-none">
            {/* 배경 딤드 */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
            />

            {/* 채팅 패널 */}
            <motion.div
              initial={{ y: '100%', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: '100%', opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-lg bg-navy-dark border-t-2 sm:border-2 border-gold/40 sm:rounded-3xl rounded-t-3xl p-4 shadow-2xl flex flex-col h-[75vh] sm:h-[600px] pointer-events-auto relative z-10"
            >
              {/* 헤더 */}
              <div className="flex justify-between items-center pb-3 border-b border-gold/20 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xl">💬</span>
                  <h3 className="font-display text-lg text-gold">사내 실시간 응원톡</h3>
                </div>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 rounded-full text-gray-400 hover:text-white hover:bg-navy-lighter"
                >
                  ✕
                </button>
              </div>

              {/* 빠른 반응 이모지 칩 */}
              <div className="flex gap-1.5 overflow-x-auto py-1 mb-2 scrollbar-none text-xs">
                {quickReactions.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleQuickReaction(r)}
                    className="px-2.5 py-1 bg-navy border border-gold/30 rounded-full text-gray-200 hover:bg-gold hover:text-navy-dark whitespace-nowrap transition-colors"
                  >
                    {r}
                  </button>
                ))}
              </div>

              {/* 메시지 리스트 */}
              <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 flex flex-col-reverse">
                <div ref={messagesEndRef} />
                {chatMessages.map((msg) => {
                  const isMe = msg.playerId === currentPlayerId
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        msg.isNotice ? 'items-center my-1' : isMe ? 'items-end' : 'items-start'
                      }`}
                    >
                      {msg.isNotice ? (
                        <div className="px-3 py-1 bg-gold/15 border border-gold/30 text-gold-light text-xs rounded-full text-center">
                          📢 {msg.message}
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 mb-0.5 text-[11px] text-gray-400">
                            <span className={isMe ? 'text-gold font-bold' : 'text-gray-300 font-medium'}>
                              {msg.nickname} {isMe && '(나)'}
                            </span>
                            <span className="text-[10px] text-gray-500">
                              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <div
                            className={`px-3.5 py-2 rounded-2xl text-sm max-w-[80%] break-words ${
                              isMe
                                ? 'bg-gradient-to-r from-gold-dark to-gold text-navy-dark font-medium rounded-tr-none'
                                : 'bg-navy border border-gold/20 text-white rounded-tl-none'
                            }`}
                          >
                            {msg.message}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* 입력창 */}
              <form onSubmit={handleSend} className="pt-3 border-t border-gold/20 flex gap-2">
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="응원이나 한마디를 남겨보세요..."
                  maxLength={50}
                  className="flex-1 px-3.5 py-2.5 bg-navy border border-gold/30 rounded-xl text-white text-sm focus:outline-none focus:border-gold"
                />
                <button
                  type="submit"
                  disabled={!text.trim()}
                  className="px-4 py-2.5 bg-gold hover:bg-gold-light disabled:opacity-40 text-navy-dark font-bold text-sm rounded-xl transition-all"
                >
                  전송
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
