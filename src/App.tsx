import { Routes, Route } from 'react-router-dom'
import PlayerPage from './pages/PlayerPage'
import AdminPage from './pages/AdminPage'
import TVPage from './pages/TVPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PlayerPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/tv" element={<TVPage />} />
    </Routes>
  )
}
