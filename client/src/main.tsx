import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import Book from './pages/public/Book.tsx';
import Booking from './pages/public/Booking.tsx';
import Family from './pages/public/Family.tsx';
import AdminLayout from './pages/admin/Layout.tsx';
import Dashboard from './pages/admin/Dashboard.tsx';
import Calendar from './pages/admin/Calendar.tsx';
import Students from './pages/admin/Students.tsx';
import Student from './pages/admin/Student.tsx';
import Log from './pages/admin/Log.tsx';
import Cancellations from './pages/admin/Cancellations.tsx';
import Settings from './pages/admin/Settings.tsx';
import Waitlist from './pages/admin/Waitlist.tsx';
import WaitlistEntry from './pages/public/WaitlistEntry.tsx';
import Invoices from './pages/admin/Invoices.tsx';
import Invoice from './pages/public/Invoice.tsx';
import Report from './pages/public/Report.tsx';
import Launch from './pages/admin/Launch.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Book />} />
        <Route path="/booking/:token" element={<Booking />} />
        <Route path="/family/:token" element={<Family />} />
        <Route path="/waitlist/:token" element={<WaitlistEntry />} />
        <Route path="/invoice/:token" element={<Invoice />} />
        <Route path="/report/:token" element={<Report />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="students" element={<Students />} />
          <Route path="students/:id" element={<Student />} />
          <Route path="log" element={<Log />} />
          <Route path="cancellations" element={<Cancellations />} />
          <Route path="waitlist" element={<Waitlist />} />
          <Route path="invoices" element={<Invoices />} />
          <Route path="settings" element={<Settings />} />
          <Route path="launch" element={<Launch />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
