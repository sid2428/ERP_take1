import { Navigate, Route, Routes } from 'react-router-dom';
import { StudentProvider } from './lib/student';
import FeesPage from './pages/FeesPage';

export default function App() {
  return (
    <StudentProvider>
      <div className="flex w-full max-w-[1240px] flex-col gap-5">
        <Routes>
          <Route path="/" element={<FeesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </StudentProvider>
  );
}
