import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import Book from './pages/public/Book.jsx';
import Booking from './pages/public/Booking.jsx';
import Family from './pages/public/Family.jsx';
import AdminLayout from './pages/admin/Layout.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import Calendar from './pages/admin/Calendar.jsx';
import Students from './pages/admin/Students.jsx';
import Student from './pages/admin/Student.jsx';
import Log from './pages/admin/Log.jsx';
import Cancellations from './pages/admin/Cancellations.jsx';
import Settings from './pages/admin/Settings.jsx';
import Waitlist from './pages/admin/Waitlist.jsx';
import WaitlistEntry from './pages/public/WaitlistEntry.jsx';
import Invoices from './pages/admin/Invoices.jsx';
import Invoice from './pages/public/Invoice.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Book />} />
        <Route path="/booking/:token" element={<Booking />} />
        <Route path="/family/:token" element={<Family />} />
        <Route path="/waitlist/:token" element={<WaitlistEntry />} />
        <Route path="/invoice/:token" element={<Invoice />} />
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
