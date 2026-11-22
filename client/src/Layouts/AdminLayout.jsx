import React, { useEffect } from 'react'
import { Outlet, Link } from 'react-router-dom'

import AdminHeader from '../components/AdminHeader'
import DraggableCalculator from '../components/DraggableCalculator'

function AdminLayout({ title }) {
  useEffect(() => {
    if (title) {
      document.title = title
    }
  }, [title])

  return (
    <div className="admin-layout ">
      <AdminHeader />
      <main  >
        <Outlet />
      </main>
      <DraggableCalculator/>
    </div>
  )
}

export default AdminLayout
