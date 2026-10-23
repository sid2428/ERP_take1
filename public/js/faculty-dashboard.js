// Centralized API Configuration
let currentFacultyId = window.__FACULTY_ID__ || 74;
const API_BASE = '/api';

// Cached Data
let cachedCourses = [];
let cachedStudents = [];
let cachedDashboard = null;

function getInitials(firstName, lastName) {
  return `${firstName || ''} ${lastName || ''}`.trim().split(/\s+/).filter(Boolean).map(part => part[0]).join('').toUpperCase() || 'F';
}

function formatDate(val) {
  if (!val) return '—';
  const d = new Date(val);
  return isNaN(d) ? val : d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}

function formatCurrency(val) {
  if (val == null) return '₹0';
  return '₹' + Number(val).toLocaleString('en-IN');
}

// Navigation between the 15 views
function navigateTo(targetId) {
  document.querySelectorAll('.side .nav, .side .nav-link').forEach(el => {
    el.classList.toggle('on', el.dataset.target === targetId);
  });
  document.querySelectorAll('.view-panel').forEach(el => {
    el.classList.toggle('active', el.id === 'view-' + targetId);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Load target page data
  switch (targetId) {
    case 'dashboard': loadDashboard(); break;
    case 'courses': loadCourses(); break;
    case 'timetable': loadTimetable(); break;
    case 'students': loadStudentList(); break;
    case 'mark-attendance': initMarkAttendance(); break;
    case 'session-records': loadSessionRecords(); break;
    case 'low-attendance': loadLowAttendance(); break;
    case 'correction-history': loadCorrectionHistory(); break;
    case 'apply-leave': initApplyLeave(); break;
    case 'my-requests': loadLeaveRequests(); break;
    case 'leave-balance': loadLeaveBalance(); break;
    case 'payslips': loadPayslips(); break;
    case 'salary-structure': loadSalaryStructure(); break;
    case 'profile': loadProfile(); break;
    case 'grievance': loadGrievances(); break;
  }
}

// 1. DASHBOARD LOADER
async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/dashboard`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedDashboard = data;

    // Header & Profile
    const prof = data.profile;
    const initials = getInitials(prof.firstName, prof.lastName);
    const topAv = document.getElementById('topAvatar');
    if (topAv) topAv.textContent = initials;
    const topNm = document.getElementById('topName');
    if (topNm) topNm.textContent = prof.fullName;
    const topEmp = document.getElementById('topEmpCode');
    if (topEmp) topEmp.textContent = prof.employeeCode;

    const heroAv = document.getElementById('heroAvatar');
    if (heroAv) heroAv.textContent = initials;
    const heroNm = document.getElementById('heroFullName');
    if (heroNm) heroNm.textContent = prof.fullName;
    const heroSb = document.getElementById('heroSub');
    if (heroSb) heroSb.textContent = `${prof.designationName} · ${prof.departmentName}`;
    const heroEmp = document.getElementById('heroEmpCode');
    if (heroEmp) heroEmp.textContent = prof.employeeCode;
    const heroJnd = document.getElementById('heroJoined');
    if (heroJnd) heroJnd.textContent = formatDate(prof.joiningDate);
    const heroCt = document.getElementById('heroContact');
    if (heroCt) heroCt.textContent = prof.contact || '—';
    const heroRt = document.getElementById('heroRoleTag');
    if (heroRt) heroRt.textContent = `Assigned · ${data.totalAssignedCourses} courses`;

    // HOD
    const hodSection = document.getElementById('hodWorkload');
    const heroHodTag = document.getElementById('heroHodTag');
    if (data.isHod) {
      hodSection?.classList.add('is-visible');
      if (heroHodTag) heroHodTag.style.display = 'inline-block';
    } else {
      hodSection?.classList.remove('is-visible');
      if (heroHodTag) heroHodTag.style.display = 'none';
    }

    // Hero facts
    const clFact = document.getElementById('heroFactCl');
    if (clFact) clFact.textContent = `${data.casualLeaveLeft} of ${data.casualLeaveTotal} days`;
    const pendFact = document.getElementById('heroFactPending');
    if (pendFact) pendFact.textContent = data.pendingLeaveRequests;
    const psFact = document.getElementById('heroFactPayslip');
    if (psFact) psFact.textContent = `${data.latestPayslipPeriod} · ${data.latestPayslipStatus}`;
    const badgeLeave = document.getElementById('badgeLeavePending');
    if (badgeLeave) badgeLeave.textContent = data.pendingLeaveRequests;

    // Badges & KPIs
    const lowCount = data.lowAttendanceAlerts ? data.lowAttendanceAlerts.length : 0;
    const badgeLow = document.getElementById('badgeLowAtt');
    if (badgeLow) badgeLow.textContent = lowCount;
    const bellCount = document.getElementById('bellCount');
    if (bellCount) bellCount.textContent = lowCount + data.pendingLeaveRequests;

    const avgVal = data.overallAvgAttendance != null ? data.overallAvgAttendance : 0;
    const kpiAvg = document.getElementById('kpiAvgAttendance');
    if (kpiAvg) kpiAvg.textContent = avgVal > 0 ? avgVal + '%' : '—';
    const kpiBar = document.getElementById('kpiAvgBar');
    if (kpiBar) kpiBar.style.width = Math.min(avgVal, 100) + '%';
    const kpiSal = document.getElementById('kpiSalarySub');
    if (kpiSal) kpiSal.textContent = `${data.latestPayslipPeriod} ${formatCurrency(data.latestNetSalary)} ${data.latestPayslipStatus.toLowerCase()}`;

    // Attendance by course rows
    const crsRows = document.getElementById('courseAttendanceRows');
    if (crsRows) {
      if (data.courses && data.courses.length > 0) {
        crsRows.innerHTML = data.courses.map(c => `
          <div class="row">
            <span>${c.courseCode} · ${c.sectionName}</span>
            <div class="bar"><i style="width:${c.avgAttendancePct || 0}%"></i><u style="left:75%"></u></div>
            <b>${c.avgAttendancePct != null ? c.avgAttendancePct + '%' : '–'}</b>
          </div>
        `).join('');
      } else {
        crsRows.innerHTML = '<div class="sm">No course offerings assigned.</div>';
      }
    }

    // Leave balance rows
    const lbRows = document.getElementById('leaveBalanceRows');
    if (lbRows && data.leaveBalances) {
      lbRows.innerHTML = data.leaveBalances.filter(b => b.paid).map(b => `
        <div class="row">
          <span>${b.leaveName}</span>
          <div class="bar"><i style="width:${b.annualQuota > 0 ? (b.balanceDays / b.annualQuota * 100) : 0}%"></i></div>
          <b>${b.balanceDays}</b>
        </div>
      `).join('');
    }

    // Courses table
    const tblBody = document.querySelector('#dashCoursesTable tbody');
    if (tblBody) {
      if (data.courses && data.courses.length > 0) {
        tblBody.innerHTML = data.courses.map(c => `
          <tr>
            <td><strong>${c.courseCode}</strong></td>
            <td>${c.courseName}</td>
            <td><span class="pill n">${c.sectionName}</span></td>
            <td><span class="pill">${c.assignmentRole}</span></td>
            <td>${c.enrolledStudents}</td>
            <td>${c.totalSessions}</td>
            <td>
              <div class="pc">
                ${c.avgAttendancePct != null ? c.avgAttendancePct + '%' : '–'}
                <div class="bar"><i style="width:${c.avgAttendancePct || 0}%"></i></div>
              </div>
            </td>
            <td>
              ${c.studentsBelow75 > 0 ? `<span class="pill o">${c.studentsBelow75} students</span>` : '<span class="pill g">None</span>'}
            </td>
          </tr>
        `).join('');
      } else {
        tblBody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:16px;color:#7A8497">No teaching courses assigned</td></tr>';
      }
      const dtStudents = document.getElementById('dashTotalStudents');
      if (dtStudents) dtStudents.textContent = data.totalEnrolledStudents;
      const dtSessions = document.getElementById('dashTotalSessions');
      if (dtSessions) dtSessions.textContent = data.totalSessionsMarked;
    }

    // Today's teaching timeline
    const timelineEl = document.getElementById('todayTimeline');
    if (timelineEl) {
      if (data.todaySessions && data.todaySessions.length > 0) {
        timelineEl.innerHTML = data.todaySessions.map((s, idx) => `
          <div class="session">
            <div class="session-time">${s.timeDisplay}</div>
            <div class="session-rail"><span class="session-dot ${idx === 0 ? 'done' : ''}"></span></div>
            <div class="session-info">
              <strong>${s.courseCode}-${s.sectionName} · ${s.courseName}</strong>
              <div class="meta">${s.classType} · ${s.room}</div>
              <div class="status-text ${idx === 0 ? 'done' : 'pending'}">${idx === 0 ? 'Scheduled' : 'Upcoming'}</div>
            </div>
            <div class="session-actions">
              <button class="action-link primary" onclick="navigateTo('mark-attendance')">Mark attendance</button>
            </div>
          </div>
        `).join('');
      } else {
        timelineEl.innerHTML = '<div class="sm" style="padding:10px 0">No lectures scheduled for today.</div>';
      }
    }

    // Needs attention
    const needsAtt = document.getElementById('dashNeedsAttention');
    if (needsAtt) {
      needsAtt.innerHTML = `
        <div class="item"><span class="dot r"></span><div class="t"><div>${lowCount} students below 75% attendance</div><a href="javascript:void(0)" onclick="navigateTo('low-attendance')">View low attendance list</a></div></div>
        <div class="item"><span class="dot b"></span><div class="t"><div>${data.pendingLeaveRequests} leave request pending approval</div><a href="javascript:void(0)" onclick="navigateTo('my-requests')">Track request</a></div></div>
      `;
    }

    // Upcoming sessions
    const upEl = document.getElementById('dashUpcomingSessions');
    if (upEl && data.todaySessions) {
      upEl.innerHTML = data.todaySessions.map(s => `
        <div class="item">
          <div class="t"><div>${s.courseCode}-${s.sectionName} · ${s.courseName}</div><div class="s">${s.dayOfWeek} · ${s.room}</div></div>
          <div class="w">${s.timeDisplay}</div>
        </div>
      `).join('') || '<div class="sm">No upcoming sessions.</div>';
    }

    // Recent corrections
    const recEl = document.getElementById('dashRecentCorrections');
    if (recEl) {
      if (data.recentCorrections && data.recentCorrections.length > 0) {
        recEl.innerHTML = data.recentCorrections.map(c => `
          <div class="item">
            <div class="t"><div>${c.studentName} · ${c.courseCode}</div><div class="s">${c.oldStatus} → ${c.newStatus} · “${c.reason}”</div></div>
            <div class="w">${c.changedByUserId}</div>
          </div>
        `).join('');
      } else {
        recEl.innerHTML = '<div class="sm">No recent attendance adjustments.</div>';
      }
    }

  } catch (err) {
    console.error('Dashboard load failed:', err);
  }
}

// 2. COURSES
async function loadCourses() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/courses`);
    const courses = await res.json();
    cachedCourses = courses;
    const tb = document.querySelector('#fullCoursesTable tbody');
    if (!tb) return;
    if (courses.length === 0) {
      tb.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:#7A8497">No course assignments found</td></tr>';
      return;
    }
    tb.innerHTML = courses.map(c => `
      <tr>
        <td><strong>${c.courseCode}</strong></td>
        <td>${c.courseName}</td>
        <td>${c.credits}</td>
        <td><span class="pill n">${c.sectionName}</span></td>
        <td>${c.termName}</td>
        <td><span class="pill">${c.assignmentRole}</span></td>
        <td>${c.enrolledStudents}</td>
        <td>${c.totalSessions}</td>
        <td><div class="pc">${c.avgAttendancePct != null ? c.avgAttendancePct + '%' : '–'}<div class="bar"><i style="width:${c.avgAttendancePct || 0}%"></i></div></div></td>
        <td><button class="btn sm" onclick="viewOfferingStudents(${c.courseOfferingId})">Roster</button></td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

// 3. TIMETABLE
async function loadTimetable() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/timetable`);
    const slots = await res.json();
    const tb = document.querySelector('#fullTimetableTable tbody');
    if (!tb) return;
    if (slots.length === 0) {
      tb.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#7A8497">No timetable slots available</td></tr>';
      return;
    }
    tb.innerHTML = slots.map(s => `
      <tr>
        <td><strong>${s.dayOfWeek}</strong></td>
        <td>${s.timeDisplay}</td>
        <td><strong>${s.courseCode}</strong></td>
        <td>${s.courseName}</td>
        <td><span class="pill n">${s.sectionName}</span></td>
        <td><span class="pill ${s.classType === 'Practical' || s.classType === 'Lab' ? 'o' : ''}">${s.classType}</span></td>
        <td>${s.room}</td>
        <td>${s.role}</td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

// 4. STUDENTS
async function loadStudentList() {
  try {
    const offSelect = document.getElementById('studentOfferingFilter');
    const selectedOff = offSelect ? offSelect.value : 0;
    
    // populate select options if needed
    if (offSelect && offSelect.options.length <= 1) {
      const crsRes = await fetch(`${API_BASE}/faculty/${currentFacultyId}/courses`);
      const courses = await crsRes.json();
      courses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.courseOfferingId;
        opt.textContent = `${c.courseCode} - Section ${c.sectionName} (${c.courseName})`;
        offSelect.appendChild(opt);
      });
    }

    let url = `${API_BASE}/faculty/${currentFacultyId}/students?`;
    if (selectedOff > 0) url += `offeringId=${selectedOff}&`;
    const res = await fetch(url);
    const students = await res.json();
    cachedStudents = students;
    renderStudents(students);
  } catch(e) {
    console.error(e);
  }
}

function renderStudents(students) {
  const tb = document.querySelector('#studentsTable tbody');
  if (!tb) return;
  if (!students || students.length === 0) {
    tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#7A8497">No enrolled students found</td></tr>';
    return;
  }
  tb.innerHTML = students.map(s => `
    <tr>
      <td><strong>${s.enrollmentNo}</strong></td>
      <td>${s.fullName}</td>
      <td>${s.departmentId}</td>
      <td>${s.admissionYear}</td>
      <td>${s.courseCode}</td>
      <td><span class="pill n">${s.sectionName}</span></td>
      <td>${s.attendedSessions} / ${s.totalSessions}</td>
      <td><strong>${s.attendancePct != null ? s.attendancePct + '%' : '–'}</strong></td>
      <td><span class="pill ${s.attendanceStatus === 'GOOD' ? 'g' : (s.attendanceStatus === 'CRITICAL' ? 'r' : 'n')}">${s.attendanceStatus}</span></td>
    </tr>
  `).join('');
}

function filterStudentsClient() {
  const searchInput = document.getElementById('studentSearchInput');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const filtered = cachedStudents.filter(s => 
    s.fullName.toLowerCase().includes(query) || s.enrollmentNo.toLowerCase().includes(query)
  );
  renderStudents(filtered);
}

function viewOfferingStudents(offeringId) {
  navigateTo('students');
  const sel = document.getElementById('studentOfferingFilter');
  if (sel) {
    sel.value = offeringId;
    loadStudentList();
  }
}

// 5. MARK ATTENDANCE
async function initMarkAttendance() {
  const sel = document.getElementById('markOfferingSelect');
  if (!sel) return;
  const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/courses`);
  const courses = await res.json();
  sel.innerHTML = courses.map(c => `
    <option value="${c.courseOfferingId}">${c.courseCode} - ${c.sectionName} (${c.courseName})</option>
  `).join('');

  const dateInput = document.getElementById('markSessionDate');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
  onMarkOfferingChange();
}

async function onMarkOfferingChange() {
  const offSelect = document.getElementById('markOfferingSelect');
  const offId = offSelect ? offSelect.value : null;
  if (!offId) return;
  const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/courses/${offId}/students`);
  const students = await res.json();
  const tb = document.querySelector('#markAttendanceTable tbody');
  if (!tb) return;
  if (students.length === 0) {
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#7A8497">No students enrolled in this offering</td></tr>';
    return;
  }
  tb.innerHTML = students.map(s => `
    <tr data-student-id="${s.studentId}">
      <td><strong>${s.enrollmentNo}</strong></td>
      <td>${s.fullName}</td>
      <td>
        <select class="mark-status-sel" style="height:32px;border:1px solid #DDE2EA;border-radius:6px;padding:0 8px">
          <option value="PRESENT" selected>Present</option>
          <option value="LATE">Late</option>
          <option value="ABSENT">Absent</option>
          <option value="EXCUSED">Excused</option>
        </select>
      </td>
      <td>
        <input type="text" class="mark-remarks" placeholder="Optional remark" style="height:32px;width:100%;border:1px solid #DDE2EA;border-radius:6px;padding:0 8px">
      </td>
    </tr>
  `).join('');
}

function markAllStatus(val) {
  document.querySelectorAll('.mark-status-sel').forEach(el => el.value = val);
}

async function submitAttendanceSession() {
  const offSelect = document.getElementById('markOfferingSelect');
  const offId = Number(offSelect ? offSelect.value : 0);
  const date = document.getElementById('markSessionDate')?.value;
  const start = (document.getElementById('markStartTime')?.value || '09:00') + ':00';
  const end = (document.getElementById('markEndTime')?.value || '10:00') + ':00';
  const topic = document.getElementById('markTopic')?.value || 'Regular session';

  const rows = document.querySelectorAll('#markAttendanceTable tbody tr');
  const records = [];
  rows.forEach(tr => {
    const sId = Number(tr.dataset.studentId);
    if (!sId) return;
    const status = tr.querySelector('.mark-status-sel')?.value || 'PRESENT';
    const remarks = tr.querySelector('.mark-remarks')?.value || '';
    records.push({ studentId: sId, attendanceStatus: status, remarks: remarks });
  });

  if (records.length === 0) {
    alert('No enrolled students available to mark attendance.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/attendance/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseOfferingId: offId,
        sessionDate: date,
        startTime: start,
        endTime: end,
        topic: topic,
        records: records
      })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to save attendance');
    alert(`Success: Attendance session recorded! (Session ID: ${result.attendanceSessionId})`);
    navigateTo('session-records');
  } catch(e) {
    alert('Error saving attendance: ' + e.message);
  }
}

// 6. SESSION RECORDS
async function loadSessionRecords() {
  try {
    const offSelect = document.getElementById('recordsOfferingFilter');
    if (offSelect && offSelect.options.length <= 1) {
      const crsRes = await fetch(`${API_BASE}/faculty/${currentFacultyId}/courses`);
      const courses = await crsRes.json();
      courses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.courseOfferingId;
        opt.textContent = `${c.courseCode} - ${c.sectionName}`;
        offSelect.appendChild(opt);
      });
    }

    let url = `${API_BASE}/faculty/${currentFacultyId}/attendance/sessions`;
    if (offSelect && offSelect.value > 0) url += `?offeringId=${offSelect.value}`;
    const res = await fetch(url);
    const sessions = await res.json();
    const tb = document.querySelector('#sessionRecordsTable tbody');
    if (!tb) return;
    if (sessions.length === 0) {
      tb.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:20px;color:#7A8497">No session records found</td></tr>';
      return;
    }
    tb.innerHTML = sessions.map(s => `
      <tr>
        <td><strong>${formatDate(s.sessionDate)}</strong></td>
        <td>${(s.startTime || '').slice(0,5)}–${(s.endTime || '').slice(0,5)}</td>
        <td><strong>${s.courseCode}</strong></td>
        <td><span class="pill n">${s.sectionName}</span></td>
        <td>${s.topic || '—'}</td>
        <td><span class="pill g">${s.presentCount}</span></td>
        <td><span class="pill o">${s.lateCount}</span></td>
        <td><span class="pill r">${s.absentCount}</span></td>
        <td><span class="pill n">${s.excusedCount}</span></td>
        <td><strong>${s.attendancePct != null ? s.attendancePct + '%' : '–'}</strong></td>
        <td><button class="btn sm" onclick="viewSessionRegister(${s.attendanceSessionId})">View Register</button></td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

async function viewSessionRegister(sessionId) {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/attendance/sessions/${sessionId}/records`);
    const records = await res.json();
    let html = `
      <table style="width:100%;margin-top:12px">
        <thead><tr><th>Enrollment No</th><th>Student Name</th><th>Status</th><th>Remarks</th></tr></thead>
        <tbody>
          ${records.map(r => `
            <tr>
              <td><strong>${r.enrollmentNo}</strong></td>
              <td>${r.fullName}</td>
              <td><span class="pill ${r.attendanceStatus === 'PRESENT' ? 'g' : (r.attendanceStatus === 'ABSENT' ? 'r' : 'o')}">${r.attendanceStatus}</span></td>
              <td>${r.remarks || '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    const titleEl = document.getElementById('payslipModalTitle');
    if (titleEl) titleEl.textContent = `Attendance Register (Session #${sessionId})`;
    const bodyEl = document.getElementById('payslipModalBody');
    if (bodyEl) bodyEl.innerHTML = html;
    document.getElementById('payslipModal')?.classList.add('open');
  } catch(e) {
    alert('Could not load register: ' + e.message);
  }
}

// 7. LOW ATTENDANCE
async function loadLowAttendance() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/attendance/low?threshold=75.0`);
    const list = await res.json();
    const tb = document.querySelector('#lowAttendanceTable tbody');
    if (!tb) return;
    if (list.length === 0) {
      tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#1D6B4A">All students are above the 75% attendance threshold!</td></tr>';
      return;
    }
    tb.innerHTML = list.map(s => `
      <tr>
        <td><strong>${s.enrollmentNo}</strong></td>
        <td>${s.fullName}</td>
        <td>${s.departmentId}</td>
        <td><strong>${s.courseCode}</strong></td>
        <td><span class="pill n">${s.sectionName}</span></td>
        <td>${s.attendedSessions} / ${s.totalSessions}</td>
        <td><span class="pill r">${s.absentSessions}</span></td>
        <td><strong style="color:#B3261E">${s.attendancePct}%</strong></td>
        <td><span class="pill o">${s.recommendation}</span></td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

function exportLowAttendanceCSV() {
  fetch(`${API_BASE}/faculty/${currentFacultyId}/attendance/low?threshold=75.0`)
    .then(r => r.json())
    .then(data => {
      let csv = 'Enrollment No,Student Name,Department,Course Code,Section,Attended,Total,Attendance %,Recommendation\n';
      data.forEach(s => {
        csv += `"${s.enrollmentNo}","${s.fullName}","${s.departmentId}","${s.courseCode}","${s.sectionName}",${s.attendedSessions},${s.totalSessions},${s.attendancePct}%,"${s.recommendation}"\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `low_attendance_faculty_${currentFacultyId}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
    });
}

// 8. AUDIT HISTORY
async function loadCorrectionHistory() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/attendance/audit`);
    const history = await res.json();
    const tb = document.querySelector('#auditHistoryTable tbody');
    if (!tb) return;
    if (history.length === 0) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#7A8497">No attendance corrections logged</td></tr>';
      return;
    }
    tb.innerHTML = history.map(a => `
      <tr>
        <td>${formatDate(a.changedAt)}</td>
        <td><strong>${a.studentName}</strong></td>
        <td>${a.enrollmentNo}</td>
        <td>${a.courseCode}</td>
        <td><span class="pill r">${a.oldStatus}</span> → <span class="pill g">${a.newStatus}</span></td>
        <td>${a.reason}</td>
        <td><span class="pill n">${a.changedByUserId}</span></td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

// 9. APPLY LEAVE
function initApplyLeave() {
  const fromInput = document.getElementById('applyFromDate');
  const toInput = document.getElementById('applyToDate');
  const today = new Date().toISOString().split('T')[0];
  if (fromInput) fromInput.value = today;
  if (toInput) toInput.value = today;
  calculateLeaveDays();
}

function calculateLeaveDays() {
  const f = new Date(document.getElementById('applyFromDate')?.value);
  const t = new Date(document.getElementById('applyToDate')?.value);
  if (!isNaN(f) && !isNaN(t) && t >= f) {
    const days = Math.round((t - f) / (1000 * 60 * 60 * 24)) + 1;
    const daysInput = document.getElementById('applyDaysRequested');
    if (daysInput) daysInput.value = days;
  }
}

async function submitLeaveApplication(e) {
  if (e) e.preventDefault();
  const alertEl = document.getElementById('applyLeaveAlert');
  if (alertEl) alertEl.innerHTML = '';

  const body = {
    leaveTypeId: Number(document.getElementById('applyLeaveType')?.value || 1),
    fromDate: document.getElementById('applyFromDate')?.value,
    toDate: document.getElementById('applyToDate')?.value,
    daysRequested: Number(document.getElementById('applyDaysRequested')?.value || 1),
    reason: document.getElementById('applyReason')?.value || ''
  };

  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/leave/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to submit leave');
    if (alertEl) alertEl.innerHTML = `<div class="alert success">Leave request #${result.leaveRequestId} submitted successfully. Waiting for admin approval.</div>`;
    document.getElementById('leaveApplyForm')?.reset();
    setTimeout(() => navigateTo('my-requests'), 1500);
  } catch(err) {
    if (alertEl) alertEl.innerHTML = `<div class="alert error">${err.message}</div>`;
  }
}

// 10. LEAVE REQUESTS
async function loadLeaveRequests() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/leave/requests`);
    const reqs = await res.json();
    const tb = document.querySelector('#leaveRequestsTable tbody');
    if (!tb) return;
    if (reqs.length === 0) {
      tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#7A8497">No leave requests recorded</td></tr>';
      return;
    }
    tb.innerHTML = reqs.map(r => `
      <tr>
        <td><strong>#${r.leaveRequestId}</strong></td>
        <td>${r.leaveName}</td>
        <td>${formatDate(r.fromDate)} – ${formatDate(r.toDate)}</td>
        <td><strong>${r.daysRequested}</strong></td>
        <td>${r.reason || '—'}</td>
        <td><span class="pill ${r.status === 'APPROVED' ? 'g' : (r.status === 'REJECTED' ? 'r' : (r.status === 'CANCELLED' ? 'n' : 'o'))}">${r.status}</span></td>
        <td>${r.approvedBy || '—'}</td>
        <td>${r.decisionRemarks || '—'}</td>
        <td>
          ${(r.status === 'PENDING' || r.status === 'APPROVED') ? `<button class="btn sm danger" onclick="cancelLeaveRequest(${r.leaveRequestId})">Cancel</button>` : '—'}
        </td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

async function cancelLeaveRequest(reqId) {
  if (!confirm(`Are you sure you want to cancel leave request #${reqId}?`)) return;
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/leave/requests/${reqId}/cancel?remarks=Cancelled%20by%20faculty`, {
      method: 'POST'
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to cancel');
    alert('Leave request cancelled.');
    loadLeaveRequests();
  } catch(e) {
    alert('Cancellation failed: ' + e.message);
  }
}

// 11. LEAVE BALANCE
async function loadLeaveBalance() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/leave/balance`);
    const balances = await res.json();
    const el = document.getElementById('leaveBalanceCards');
    if (!el) return;
    el.innerHTML = balances.map(b => {
      const pct = b.annualQuota > 0 ? Math.round((b.balanceDays / b.annualQuota) * 100) : 0;
      return `
        <div class="card">
          <div class="hd"><h2>${b.leaveName}</h2><span class="pill ${b.paid ? 'g' : 'n'}">${b.paid ? 'Paid' : 'Unpaid'}</span></div>
          <div class="note">Annual Quota: ${b.annualQuota} days</div>
          <div class="kpi">${b.balanceDays} <small>days left</small></div>
          <div class="bar"><i class="${pct < 25 ? 'bad' : (pct < 50 ? 'warn' : 'good')}" style="width:${pct}%"></i></div>
          <div class="sm">${b.annualQuota - b.balanceDays} days used this calendar year</div>
        </div>
      `;
    }).join('');
  } catch(e) {
    console.error(e);
  }
}

// 12. PAYSLIPS
async function loadPayslips() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/payroll/payslips`);
    const payslips = await res.json();
    const tb = document.querySelector('#payslipsTable tbody');
    if (!tb) return;
    if (payslips.length === 0) {
      tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#7A8497">No payslip records generated yet</td></tr>';
      return;
    }
    tb.innerHTML = payslips.map(p => `
      <tr>
        <td><strong>${p.periodText}</strong></td>
        <td>${formatCurrency(p.basicSalary)}</td>
        <td>${formatCurrency(p.allowances)}</td>
        <td>${formatCurrency(p.deductions)}</td>
        <td>${formatCurrency(p.leaveDeductions)}</td>
        <td><strong style="color:#1D6B4A">${formatCurrency(p.netSalary)}</strong></td>
        <td><span class="pill ${p.status === 'PAID' ? 'g' : (p.status === 'APPROVED' ? 'o' : 'n')}">${p.status}</span></td>
        <td>${formatDate(p.paidAt)}</td>
        <td><button class="btn sm" onclick="viewPayslipDetail(${p.payrollId})">View Payslip</button></td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

async function viewPayslipDetail(payrollId) {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/payroll/payslips/${payrollId}`);
    const p = await res.json();
    const body = `
      <div style="background:#F8F9FB;padding:16px;border-radius:8px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><h3 style="margin:0">${document.getElementById('topName')?.textContent || 'Faculty'}</h3><small>${p.periodText} · Status: <strong>${p.status}</strong></small></div>
          <div style="font-size:22px;font-weight:700;color:#1D6B4A">${formatCurrency(p.netSalary)}</div>
        </div>
      </div>
      <table style="width:100%">
        <thead><tr><th>Component</th><th>Type</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          ${(p.items || []).map(i => `
            <tr>
              <td>${i.componentName}</td>
              <td><span class="pill ${i.componentType === 'BASIC' ? '' : (i.componentType === 'ALLOWANCE' ? 'g' : 'r')}">${i.componentType}</span></td>
              <td style="text-align:right;font-weight:600">${formatCurrency(i.amount)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr><td colspan="2"><strong>Net Payable Amount</strong></td><td style="text-align:right;font-weight:700;color:#1D6B4A">${formatCurrency(p.netSalary)}</td></tr>
        </tfoot>
      </table>
    `;
    const titleEl = document.getElementById('payslipModalTitle');
    if (titleEl) titleEl.textContent = `Payslip Statement — ${p.periodText}`;
    const bodyEl = document.getElementById('payslipModalBody');
    if (bodyEl) bodyEl.innerHTML = body;
    document.getElementById('payslipModal')?.classList.add('open');
  } catch(e) {
    alert('Failed to load payslip: ' + e.message);
  }
}

function closePayslipModal() {
  document.getElementById('payslipModal')?.classList.remove('open');
}

// 13. SALARY STRUCTURE
async function loadSalaryStructure() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/payroll/salary-structure`);
    const list = await res.json();
    const el = document.getElementById('salaryStructureCards');
    if (!el) return;
    if (list.length === 0) {
      el.innerHTML = '<div class="card"><div class="sm">No salary structure configured for this faculty member.</div></div>';
      return;
    }
    el.innerHTML = list.map(s => `
      <div class="card">
        <div class="hd"><h2>Salary Structure #${s.salaryStructureId}</h2><span class="pill ${s.active ? 'g' : 'n'}">${s.active ? 'Active' : 'Archived'}</span></div>
        <div class="note">Effective from ${formatDate(s.effectiveFrom)} ${s.effectiveTo ? 'to ' + formatDate(s.effectiveTo) : '(Current)'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          <div><small style="color:#5B6578">Basic Salary</small><div style="font-size:16px;font-weight:600">${formatCurrency(s.basicSalary)}</div></div>
          <div><small style="color:#5B6578">Allowances</small><div style="font-size:16px;font-weight:600">${formatCurrency(s.allowances)}</div></div>
          <div><small style="color:#5B6578">Standard Deductions</small><div style="font-size:16px;font-weight:600;color:#B3261E">${formatCurrency(s.deductions)}</div></div>
          <div><small style="color:#5B6578">Leave Ded. / Day</small><div style="font-size:16px;font-weight:600">${formatCurrency(s.leaveDeductionPerDay)}</div></div>
        </div>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #EEF0F5;display:flex;justify-content:space-between;align-items:center">
          <span>Estimated Monthly Net</span>
          <span style="font-size:18px;font-weight:700;color:#1D6B4A">${formatCurrency(s.estimatedNetSalary)}</span>
        </div>
      </div>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

// 14. PROFILE
async function loadProfile() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}`);
    const f = await res.json();
    const ec = document.getElementById('profEmpCode');
    if (ec) ec.value = f.employeeCode;
    const uid = document.getElementById('profUserId');
    if (uid) uid.value = f.userId || '—';
    const fn = document.getElementById('profFullName');
    if (fn) fn.value = f.fullName;
    const em = document.getElementById('profEmail');
    if (em) em.value = f.email || '—';
    const dp = document.getElementById('profDepartment');
    if (dp) dp.value = f.departmentName;
    const ds = document.getElementById('profDesignation');
    if (ds) ds.value = f.designationName;
    const jd = document.getElementById('profJoiningDate');
    if (jd) jd.value = formatDate(f.joiningDate);
    const st = document.getElementById('profStatus');
    if (st) st.value = f.active ? 'Active' : 'Inactive';
    const ct = document.getElementById('profContact');
    if (ct) ct.value = f.contact || '';
  } catch(e) {
    console.error(e);
  }
}

async function updateFacultyContact() {
  const alertEl = document.getElementById('profileAlert');
  if (alertEl) alertEl.innerHTML = '';
  const newContact = document.getElementById('profContact')?.value.trim();

  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: newContact })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Update failed');
    if (alertEl) alertEl.innerHTML = `<div class="alert success">Contact updated successfully!</div>`;
    loadDashboard();
  } catch(e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert error">${e.message}</div>`;
  }
}

// 15. GRIEVANCE
async function loadGrievances() {
  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/grievance`);
    const list = await res.json();
    const tb = document.querySelector('#grievanceTable tbody');
    if (!tb) return;
    if (list.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#7A8497">No grievances submitted</td></tr>';
      return;
    }
    tb.innerHTML = list.map(g => `
      <tr>
        <td><strong>#${g.grievanceId}</strong></td>
        <td>${formatDate(g.createdAt)}</td>
        <td><span class="pill n">${g.category}</span></td>
        <td><strong>${g.title}</strong><div style="font-size:12px;color:#5B6578;margin-top:2px">${g.description}</div></td>
        <td><span class="pill ${g.status === 'RESOLVED' ? 'g' : (g.status === 'IN_REVIEW' ? 'o' : 'n')}">${g.status}</span></td>
        <td>${g.resolutionRemarks || 'Pending administrative review'}</td>
      </tr>
    `).join('');
  } catch(e) {
    console.error(e);
  }
}

async function submitGrievance() {
  const cat = document.getElementById('grievanceCategory')?.value;
  const title = document.getElementById('grievanceTitle')?.value.trim();
  const desc = document.getElementById('grievanceDescription')?.value.trim();
  const alertEl = document.getElementById('grievanceAlert');

  if (!title || !desc) {
    if (alertEl) alertEl.innerHTML = '<div class="alert error">Please fill in both the title and description.</div>';
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/faculty/${currentFacultyId}/grievance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: cat, title: title, description: desc })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Submission failed');
    if (document.getElementById('grievanceTitle')) document.getElementById('grievanceTitle').value = '';
    if (document.getElementById('grievanceDescription')) document.getElementById('grievanceDescription').value = '';
    const formCard = document.getElementById('grievanceFormCard');
    if (formCard) formCard.style.display = 'none';
    loadGrievances();
    alert('Grievance submitted successfully. Tracking ID: #' + result.grievanceId);
  } catch(e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert error">${e.message}</div>`;
  }
}

function switchFaculty(id) {
  currentFacultyId = id;
  loadDashboard();
}

// Global search input
document.getElementById('globalSearchInput')?.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) return;
  if (q.includes('leave') || q.includes('request')) navigateTo('my-requests');
  else if (q.includes('student') || q.includes('roster')) navigateTo('students');
  else if (q.includes('salary') || q.includes('payslip')) navigateTo('payslips');
  else if (q.includes('course')) navigateTo('courses');
  else if (q.includes('attendance') || q.includes('mark')) navigateTo('mark-attendance');
});

// Dropdowns and UI Setup
document.addEventListener('DOMContentLoaded', () => {
  const btnBell = document.getElementById('btnBell');
  const bellDropdown = document.getElementById('bellDropdown');
  btnBell?.addEventListener('click', (e) => {
    e.stopPropagation();
    bellDropdown?.classList.toggle('open');
    document.getElementById('userMenuDropdown')?.classList.remove('open');
  });

  const btnUserMenu = document.getElementById('btnUserMenu');
  const userMenuDropdown = document.getElementById('userMenuDropdown');
  btnUserMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    userMenuDropdown?.classList.toggle('open');
    bellDropdown?.classList.remove('open');
  });

  document.addEventListener('click', () => {
    bellDropdown?.classList.remove('open');
    userMenuDropdown?.classList.remove('open');
  });

  // Attach nav listeners
  document.querySelectorAll('.side .nav, .side .nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      const target = link.dataset.target;
      if (target) {
        e.preventDefault();
        navigateTo(target);
      }
    });
  });

  const urlParams = new URLSearchParams(window.location.search);
  const pageParam = urlParams.get('page') || (window.location.hash ? window.location.hash.substring(1) : null);
  const facultyParam = urlParams.get('facultyId');
  if (facultyParam && Number(facultyParam) > 0) currentFacultyId = Number(facultyParam);
  
  if (pageParam && pageParam !== 'dashboard') {
    navigateTo(pageParam);
  } else {
    loadDashboard();
  }
});
