module.exports = function renderAdmin() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CardioCare Admin Dashboard</title>
    <script src="https://unpkg.com/lucide@latest"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --coral: #FF6B6B; --navy: #24324A; --mint: #BDF3DE; --sky: #BDE5FF; --white: #FFFFFF;
            --bg: #F8F9FA; --text: #344054; --border: #E4E7EC;
            --clay-shadow: 6px 6px 12px rgba(0, 0, 0, 0.05), -6px -6px 12px #FFFFFF;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: var(--bg); color: var(--text); }
        
        /* Auth Screen */
        #auth-screen { display: flex; height: 100vh; align-items: center; justify-content: center; }
        .auth-card { background: var(--white); padding: 40px; border-radius: 24px; box-shadow: var(--clay-shadow); width: 100%; max-width: 400px; text-align: center; }
        .input-group { margin-bottom: 20px; text-align: left; }
        .input-group label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 0.9rem; }
        .input-group input { width: 100%; padding: 12px; border: 2px solid var(--border); border-radius: 12px; transition: 0.2s; }
        .input-group input:focus { border-color: var(--sky); outline: none; }
        .btn { background: var(--coral); color: white; border: none; padding: 12px 24px; border-radius: 12px; cursor: pointer; font-weight: 600; width: 100%; display: flex; justify-content: center; gap: 8px; box-shadow: 0 4px 6px rgba(255,107,107,0.2); }
        .btn:disabled { opacity: 0.7; }
        
        /* Dashboard Screen */
        #dashboard-screen { display: none; min-height: 100vh; }
        .sidebar { width: 250px; background: var(--navy); color: white; position: fixed; height: 100vh; padding: 24px; }
        .sidebar h2 { display: flex; align-items: center; gap: 8px; color: var(--mint); margin-bottom: 40px; }
        .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px; color: #D0D5DD; text-decoration: none; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: 0.2s; }
        .nav-item:hover, .nav-item.active { background: rgba(255,255,255,0.1); color: white; }
        
        .main-content { margin-left: 250px; padding: 32px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
        
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; margin-bottom: 32px; }
        .stat-card { background: var(--white); padding: 24px; border-radius: 16px; box-shadow: var(--clay-shadow); border-left: 4px solid var(--coral); }
        .stat-card h3 { font-size: 0.9rem; color: #667085; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-card .value { font-size: 2rem; font-weight: 700; color: var(--navy); }
        
        .table-container { background: var(--white); border-radius: 16px; padding: 24px; box-shadow: var(--clay-shadow); overflow-x: auto; }
        .filters { display: flex; gap: 16px; margin-bottom: 16px; }
        select, input[type="date"] { padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 16px; text-align: left; border-bottom: 1px solid var(--border); }
        th { background: #F9FAFB; font-weight: 600; color: #475467; font-size: 0.85rem; text-transform: uppercase; }
        
        .status { padding: 4px 12px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: capitalize; }
        .status.pending { background: #FEF0C7; color: #B54708; }
        .status.confirmed { background: #D1FADF; color: #027A48; }
        .status.completed { background: #E0EAFF; color: #3538CD; }
        .status.cancelled { background: #FEE4E2; color: #B42318; }
        
        .action-select { padding: 6px; border-radius: 6px; border: 1px solid var(--border); font-size: 0.85rem; cursor: pointer; }
        
        #toast { position: fixed; bottom: 24px; right: 24px; background: var(--navy); color: white; padding: 16px 24px; border-radius: 8px; transform: translateY(100px); opacity: 0; transition: 0.3s; box-shadow: 0 10px 15px rgba(0,0,0,0.1); }
        #toast.show { transform: translateY(0); opacity: 1; }
    </style>
</head>
<body>
    <div id="toast"></div>

    <div id="auth-screen">
        <div class="auth-card">
            <h2 style="margin-bottom: 24px; color: var(--navy);"><i data-lucide="shield-check" style="vertical-align: middle;"></i> Admin Login</h2>
            <div id="login-error" style="color: red; margin-bottom: 16px; font-size: 0.9rem;"></div>
            <form id="login-form">
                <div class="input-group">
                    <label>Username</label>
                    <input type="text" id="username" required autocomplete="username">
                </div>
                <div class="input-group">
                    <label>Password</label>
                    <input type="password" id="password" required autocomplete="current-password">
                </div>
                <button type="submit" class="btn" id="login-btn">Secure Login <i data-lucide="log-in"></i></button>
            </form>
        </div>
    </div>

    <div id="dashboard-screen">
        <div class="sidebar">
            <h2><i data-lucide="heart-pulse"></i> CardioCare</h2>
            <div class="nav-item active"><i data-lucide="calendar"></i> Appointments</div>
            <div class="nav-item" onclick="admin.logout()"><i data-lucide="log-out"></i> Logout</div>
        </div>
        <div class="main-content">
            <div class="header">
                <h2>Overview</h2>
                <div id="current-time" style="color: #667085; font-weight: 500;"></div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card"><h3>Total Bookings</h3><div class="value" id="stat-total">-</div></div>
                <div class="stat-card" style="border-color: var(--mint);"><h3>Today's Appts</h3><div class="value" id="stat-today">-</div></div>
                <div class="stat-card" style="border-color: #F79009;"><h3>Pending</h3><div class="value" id="stat-pending">-</div></div>
                <div class="stat-card" style="border-color: #12B76A;"><h3>Confirmed</h3><div class="value" id="stat-confirmed">-</div></div>
            </div>

            <div class="table-container">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <h3>Recent Appointments</h3>
                    <div class="filters">
                        <select id="filter-status" onchange="admin.loadAppointments()">
                            <option value="">All Statuses</option>
                            <option value="pending">Pending</option>
                            <option value="confirmed">Confirmed</option>
                            <option value="completed">Completed</option>
                            <option value="cancelled">Cancelled</option>
                        </select>
                        <input type="date" id="filter-date" onchange="admin.loadAppointments()">
                        <button class="btn" style="padding: 10px; width: auto;" onclick="document.getElementById('filter-date').value=''; admin.loadAppointments();"><i data-lucide="x"></i></button>
                    </div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Ref / Date</th>
                            <th>Patient</th>
                            <th>Type</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="table-body">
                        <tr><td colspan="5" style="text-align: center; padding: 24px;">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        lucide.createIcons();
        setInterval(() => {
            document.getElementById('current-time').textContent = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        }, 1000);

        const admin = {
            async init() {
                try {
                    const res = await fetch('/api/admin/me');
                    if (res.ok) this.showDashboard();
                    else this.showLogin();
                } catch { this.showLogin(); }
            },

            showLogin() {
                document.getElementById('dashboard-screen').style.display = 'none';
                document.getElementById('auth-screen').style.display = 'flex';
            },

            showDashboard() {
                document.getElementById('auth-screen').style.display = 'none';
                document.getElementById('dashboard-screen').style.display = 'block';
                this.loadStats();
                this.loadAppointments();
            },

            showToast(msg) {
                const t = document.getElementById('toast');
                t.textContent = msg;
                t.classList.add('show');
                setTimeout(() => t.classList.remove('show'), 3000);
            },

            async loadStats() {
                const res = await fetch('/api/admin/stats');
                if (res.ok) {
                    const data = await res.json();
                    document.getElementById('stat-total').textContent = data.total;
                    document.getElementById('stat-today').textContent = data.today;
                    document.getElementById('stat-pending').textContent = data.pending;
                    document.getElementById('stat-confirmed').textContent = data.confirmed;
                }
            },

            async loadAppointments() {
                const status = document.getElementById('filter-status').value;
                const date = document.getElementById('filter-date').value;
                let query = '?';
                if (status) query += 'status=' + status + '&';
                if (date) query += 'date=' + date;

                const res = await fetch('/api/admin/appointments' + query);
                const tbody = document.getElementById('table-body');
                
                if (res.ok) {
                    const data = await res.json();
                    tbody.innerHTML = '';
                    if (data.appointments.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No appointments found.</td></tr>';
                        return;
                    }

                    data.appointments.forEach(apt => {
                        const tr = document.createElement('tr');
                        const dateStr = new Date(apt.appointmentStart).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                        
                        tr.innerHTML = \`
                            <td><strong>\${apt.bookingReference}</strong><br><small style="color: #667085;">\${dateStr}</small></td>
                            <td><strong>\${apt.patientName}</strong><br><small style="color: #667085;">\${apt.phone}</small></td>
                            <td>\${apt.consultationType}<br><small>₹\${apt.consultationFee}</small></td>
                            <td><span class="status \${apt.status}">\${apt.status}</span></td>
                            <td>
                                <select class="action-select" onchange="admin.changeStatus('\${apt._id}', this.value)">
                                    <option value="" disabled selected>Update Status</option>
                                    \${apt.status !== 'confirmed' ? '<option value="confirmed">Confirm</option>' : ''}
                                    \${apt.status !== 'completed' ? '<option value="completed">Complete</option>' : ''}
                                    \${apt.status !== 'cancelled' ? '<option value="cancelled">Cancel</option>' : ''}
                                </select>
                            </td>
                        \`;
                        tbody.appendChild(tr);
                    });
                } else if (res.status === 401) {
                    this.showLogin();
                }
            },

            async changeStatus(id, newStatus) {
                if (!confirm(\`Are you sure you want to mark this as \${newStatus}?\`)) {
                    this.loadAppointments(); // reset select
                    return;
                }
                const res = await fetch('/api/admin/appointments/' + id + '/status', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: newStatus })
                });
                if (res.ok) {
                    this.showToast('Status updated successfully');
                    this.loadStats();
                    this.loadAppointments();
                } else {
                    this.showToast('Error updating status');
                }
            },

            async logout() {
                await fetch('/api/admin/logout', { method: 'POST' });
                this.showLogin();
            }
        };

        document.getElementById('login-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('login-btn');
            const err = document.getElementById('login-error');
            btn.disabled = true; err.textContent = '';
            
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('username').value,
                    password: document.getElementById('password').value
                })
            });
            
            if (res.ok) {
                admin.showDashboard();
            } else {
                err.textContent = 'Invalid credentials';
            }
            btn.disabled = false;
        };

        admin.init();
    </script>
</body>
</html>`;
}
