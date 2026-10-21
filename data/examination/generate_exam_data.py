import numpy as np, pandas as pd, datetime as dt, os
rng=np.random.default_rng(7)
ATT=os.environ.get('ATT_DIR','/mnt/user-data/outputs/attendance_dataset/'); OUT=os.environ.get('OUT_DIR','/mnt/user-data/outputs/exam_dataset/')
UP=os.environ.get('IN_DIR','/mnt/user-data/uploads/')
cfg=pd.read_csv(ATT+'course_attendance_config.csv'); mp=pd.read_csv(ATT+'student_section_mapping.csv')
asg=pd.read_csv(ATT+'teaching_assignments.csv'); summ=pd.read_csv(ATT+'attendance_summary.csv')
crs=pd.read_excel(UP+'faculty_dataset__1_.xlsx',sheet_name='Courses')
coord=dict(zip(crs.Course_ID,crs.Course_Coordinator_ID))

# ---------- grade scale ----------
gs=pd.DataFrame([('O',80,100,10,'Outstanding'),('A+',70,79.99,9,'Excellent'),('A',60,69.99,8,'Very Good'),('B+',55,59.99,7,'Good'),
 ('B',50,54.99,6,'Above Average'),('C',45,49.99,5,'Average'),('P',40,44.99,4,'Pass'),('F',0,39.99,0,'Fail')],
 columns=['grade','min_percentage','max_percentage','grade_points','description'])
gs.to_csv(OUT+'grade_scale.csv',index=False)
def grade(p):
    return np.select([p>=80,p>=70,p>=60,p>=55,p>=50,p>=45,p>=40],['O','A+','A','B+','B','C','P'],'F'), \
           np.select([p>=80,p>=70,p>=60,p>=55,p>=50,p>=45,p>=40],[10,9,8,7,6,5,4],0)

# ---------- assessment scheme per course ----------
th_schemes=[(20,30,50),(30,20,50),(25,25,50),(20,20,60)]
rows=[]
for r in cfg.itertuples():
    if r.course_type=='Lab':
        cr=2 if r.course_id%2==0 else 1; i,m,e=(50,0,50) if cr==2 else (25,0,25)
    elif r.is_tutorial==1: cr=1; i,m,e=25,0,0
    else:
        cr=4 if r.course_id%3==0 else 3; i,m,e=th_schemes[r.course_id%4]
    rows.append((r.course_id,cr,i,m,e,i+m+e,40))
sch=pd.DataFrame(rows,columns=['course_id','credits','internal_max','midsem_max','endsem_max','total_max','passing_percentage'])
sch.to_csv(OUT+'course_exam_scheme.csv',index=False)
S=sch.set_index('course_id')

# ---------- exam cycles ----------
def monday_on_or_after(d):
    return d+dt.timedelta(days=(7-d.weekday())%7)
AYS=[2023,2024,2025,2026]; cyc=[];cid=0;cmap={}
for a in AYS:
    ay=f"{a}-{str(a+1)[2:]}"
    ms=monday_on_or_after(dt.date(a,10,5)); es=monday_on_or_after(dt.date(a,11,23)); sp=monday_on_or_after(dt.date(a+1,6,15))
    defs=[('MidSem',ms,ms+dt.timedelta(days=4),ms-dt.timedelta(days=0),ms+dt.timedelta(days=9)),
          ('EndSem',es-dt.timedelta(days=7),es+dt.timedelta(days=11),dt.date(a,10,5),dt.date(a,10,14))]
    # EndSem window incl. practical/oral week before theory
    defs[1]=('EndSem',es-dt.timedelta(days=7),es+dt.timedelta(days=11),dt.date(a,10,5),dt.date(a,10,14))
    if a<2026: defs.append(('Supplementary',sp,sp+dt.timedelta(days=11),sp-dt.timedelta(days=30),sp-dt.timedelta(days=10)))
    for t,s,e,ro,rc in defs:
        cid+=1; cmap[(a,t)]=cid
        if a<2026: st='Completed'
        else: st='Completed' if t=='MidSem' else 'Registration Closed'
        cyc.append((cid,ay,'Odd',t,s,e,ro if t!='MidSem' else None,rc if t!='MidSem' else None,st))
cyc=pd.DataFrame(cyc,columns=['exam_cycle_id','academic_year','semester_type','exam_type','start_date','end_date','registration_open','registration_close','status'])
cyc.to_csv(OUT+'exam_cycles.csv',index=False)

# ---------- schedule (2026-27 MidSem + EndSem) ----------
sched=[];sid=0
cd=cfg.merge(sch,on='course_id')
mid_start=cyc[cyc.exam_cycle_id==cmap[(2026,'MidSem')]].start_date.iloc[0]
end_start=monday_on_or_after(dt.date(2026,11,23)); prac_start=end_start-dt.timedelta(days=7)
def wd(start,i): return start+dt.timedelta(days=i%5+7*(i//5))
for (d,y),g in cd.groupby(['department_id','year_of_study']):
    th=g[(g.course_type=='Theory')&(g.is_tutorial==0)].sort_values('course_id')
    for i,r in enumerate(th.itertuples()):
        sid+=1; sched.append((sid,cmap[(2026,'MidSem')],r.course_id,'MidSem',mid_start+dt.timedelta(days=i%5),'Morning' if i<5 else 'Afternoon','10:00' if i<5 else '14:00','11:30' if i<5 else '15:30',90,r.midsem_max))
        sid+=1; dte=wd(end_start,i); dur=120 if r.endsem_max<=50 else 150
        sched.append((sid,cmap[(2026,'EndSem')],r.course_id,'EndSem Theory',dte,'Morning','10:30','12:30' if dur==120 else '13:00',dur,r.endsem_max))
    for i,r in enumerate(g[g.course_type=='Lab'].sort_values('course_id').itertuples()):
        sid+=1; sched.append((sid,cmap[(2026,'EndSem')],r.course_id,'Practical/Oral',prac_start+dt.timedelta(days=i%5),'Morning','09:00','13:00',240,r.endsem_max))
sched=pd.DataFrame(sched,columns=['schedule_id','exam_cycle_id','course_id','exam_mode','exam_date','session','start_time','end_time','duration_min','max_marks'])
sched.to_csv(OUT+'exam_schedule.csv',index=False)

# ---------- student ability ----------
ov=summ.groupby('student_number').agg(a=('lectures_attended','sum'),t=('total_lectures','sum')); ov['p']=100*ov.a/ov.t
z=((ov.p-ov.p.mean())/ov.p.std()).to_dict()
stu=mp[['student_number','department_id','year_of_study']].copy()
stu['ability']=0.9*rng.normal(size=len(stu))+0.45*stu.student_number.map(z)
ceff={c:rng.normal(0,4) for c in cfg.course_id}

def comp_marks(base,mx,shift,sd):
    pct=np.clip(base+shift+rng.normal(0,sd,size=len(base)),0,100)
    return np.where(mx>0,np.round(pct*mx/100),np.nan),pct

# ---------- history (years < current year), attempt 1 ----------
h=stu[stu.year_of_study>1].merge(cfg[['course_id','department_id','year_of_study','course_type','is_tutorial']].rename(columns={'year_of_study':'course_year'}),on='department_id')
h=h[h.course_year<h.year_of_study].copy().reset_index(drop=True)
h['ay_start']=2027-h.year_of_study+h.course_year-1
h['credits']=h.course_id.map(S.credits); 
for c in ['internal_max','midsem_max','endsem_max','total_max']: h[c]=h.course_id.map(S[c])
base=64+11*h.ability.values+h.course_id.map(ceff).values+rng.normal(0,6,size=len(h))
h['internal_marks'],_=comp_marks(base,h.internal_max.values,6,5)
h['midsem_marks'],_=comp_marks(base,h.midsem_max.values,-2,7)
h['endsem_marks'],_=comp_marks(base,h.endsem_max.values,-3,8)
absent=(h.endsem_max>0)&(rng.random(len(h))<0.01)
h.loc[absent,'endsem_marks']=np.nan
h['endsem_status']=np.where(h.endsem_max==0,'NA',np.where(absent,'Absent','Present'))
h['attempt_no']=1
h['cycle']=[cmap[(a,'EndSem')] for a in h.ay_start]
h['entered_by']=h.course_id.map(coord)
def totals(df):
    return df[['internal_marks','midsem_marks','endsem_marks']].fillna(0).sum(axis=1)
h['total']=totals(h); h['pct']=100*h.total/h.total_max; h['fail']=h.pct<40
# attempt 2 (supplementary) for failures
f=h[h.fail].copy(); f=f[rng.random(len(f))<0.85].copy()
f['attempt_no']=2; f['cycle']=[cmap[(a,'Supplementary')] for a in f.ay_start]
newp=np.clip(rng.normal(55,12,size=len(f)),0,100)
has_e=f.endsem_max>0
f.loc[has_e,'endsem_marks']=np.round(newp[has_e.values]*f.endsem_max[has_e]/100)
f.loc[~has_e,'internal_marks']=np.round(newp[(~has_e).values]*f.internal_max[~has_e]/100)
f['endsem_status']=np.where(f.endsem_max==0,'NA','Present')
f['total']=totals(f); f['pct']=100*f.total/f.total_max; f['fail']=f.pct<40
hist=pd.concat([h,f],ignore_index=True)
cyc_end=cyc.set_index('exam_cycle_id').end_date.to_dict()
hist['last_updated']=[pd.Timestamp(cyc_end[c])+pd.Timedelta(days=int(30 if t==1 else 20),hours=11) for c,t in zip(hist.cycle,hist.attempt_no)]
hist['academic_year']=[f"{a}-{str(a+1)[2:]}" for a in hist.ay_start]; hist['semester']=2*hist.course_year-1
last2=hist.groupby(['student_number','course_id']).attempt_no.transform('max')
hist['is_final_attempt']=(hist.attempt_no==last2).astype(int)
gr,gp=grade(hist.pct.values); hist['grade']=gr; hist['grade_points']=gp
hist['result_status']=np.where(hist.fail,'Fail','Pass')
hist['credits_earned']=np.where(hist.fail,0,hist.credits)

# ---------- current term rows (2026-27, odd sem) ----------
cur=summ[['student_number','course_id','semester','academic_year']].merge(stu[['student_number','ability']],on='student_number')
cur=cur.merge(summ[['student_number','course_id','attendance_percentage']],on=['student_number','course_id'])
for c in ['internal_max','midsem_max','endsem_max']: cur[c]=cur.course_id.map(S[c])
base=64+11*cur.ability.values+cur.course_id.map(ceff).values+0.15*(cur.attendance_percentage.values-82)+rng.normal(0,6,size=len(cur))
cur['internal_marks']=np.nan
cur['midsem_marks'],_=comp_marks(base,cur.midsem_max.values,-2,7)
cur['endsem_marks']=np.nan
cur['endsem_status']=np.where(cur.endsem_max==0,'NA','Pending'); cur['attempt_no']=1; cur['cycle']=cmap[(2026,'EndSem')]
fa=asg[asg.session_type=='Lecture'].merge(mp[['division_id','student_number']].drop_duplicates(),on='division_id')[['student_number','course_id','faculty_id']]
cur=cur.merge(fa,on=['student_number','course_id'],how='left')
has=cur.midsem_marks.notna()
cur['entered_by']=np.where(has,cur.faculty_id,np.nan)
cur['last_updated']=pd.NaT
ts=pd.Timestamp('2026-10-12')+pd.to_timedelta(rng.integers(0,3*24*60,size=len(cur)),unit='m')+pd.Timedelta(hours=10)
cur.loc[has,'last_updated']=ts[has.values]

cols=['student_number','course_id','attempt_no','cycle','internal_marks','midsem_marks','endsem_marks','endsem_status','entered_by','last_updated']
mk=pd.concat([hist[cols],cur[cols]],ignore_index=True).sort_values(['student_number','course_id','attempt_no']).reset_index(drop=True)
mk.insert(0,'marks_id',np.arange(1,len(mk)+1)); mk=mk.rename(columns={'cycle':'exam_cycle_id'})
mk['entered_by']=mk.entered_by.astype('Int64')
mk.to_csv(OUT+'exam_marks.csv',index=False,date_format='%Y-%m-%d %H:%M:%S')

# ---------- course_result (history only: completed semesters) ----------
cr=hist.copy()
cr_out=pd.DataFrame({'student_number':cr.student_number,'course_id':cr.course_id,'academic_year':cr.academic_year,'semester':cr.semester,'attempt_no':cr.attempt_no,
 'total_marks':cr.total,'max_marks':cr.total_max,'percentage':cr.pct.round(2),'grade':cr.grade,'grade_points':cr.grade_points,'credits':cr.credits,
 'credits_earned':cr.credits_earned,'result_status':cr.result_status,'is_final_attempt':cr.is_final_attempt})
cr_out=cr_out.sort_values(['student_number','course_id','attempt_no']).reset_index(drop=True)
cr_out.insert(0,'result_id',np.arange(1,len(cr_out)+1)); cr_out['total_marks']=cr_out.total_marks.astype(int)
cr_out.to_csv(OUT+'course_result.csv',index=False)

# ---------- semester_result & student_cgpa (final attempts) ----------
fin=cr_out[cr_out.is_final_attempt==1].copy(); fin['pts']=fin.credits*fin.grade_points
sr=fin.groupby(['student_number','academic_year','semester']).agg(credits_registered=('credits','sum'),credits_earned=('credits_earned','sum'),pts=('pts','sum'),backlogs=('result_status',lambda s:(s=='Fail').sum())).reset_index()
sr['sgpa']=((200*sr.pts+sr.credits_registered)//(2*sr.credits_registered))/100; sr['result_status']=np.where(sr.backlogs==0,'Pass','ATKT'); sr=sr.drop(columns='pts')
sr.insert(0,'semester_result_id',np.arange(1,len(sr)+1)); sr=sr[['semester_result_id','student_number','academic_year','semester','credits_registered','credits_earned','sgpa','backlogs','result_status']]
sr.to_csv(OUT+'semester_result.csv',index=False)
cg=fin.groupby('student_number').agg(credits_attempted=('credits','sum'),credits_earned=('credits_earned','sum'),pts=('pts','sum'),backlog_count=('result_status',lambda s:(s=='Fail').sum()),semesters_completed=('semester','nunique')).reset_index()
cg['cgpa']=((200*cg.pts+cg.credits_attempted)//(2*cg.credits_attempted))/100; cg=cg[['student_number','semesters_completed','credits_attempted','credits_earned','cgpa','backlog_count']]
cg.to_csv(OUT+'student_cgpa.csv',index=False)

# ---------- registration + hall tickets (2026-27 EndSem) ----------
reg=summ[['student_number','course_id','attendance_percentage','eligibility_status']].copy()
reg=reg[reg.course_id.map(S.endsem_max)>0].reset_index(drop=True)
ok=reg.eligibility_status=='Eligible'
reg['registration_status']=np.where(ok,'Registered','Blocked'); reg['blocked_reason']=np.where(ok,'','Attendance below 75%')
rt=pd.Timestamp('2026-10-05')+pd.to_timedelta(rng.integers(0,9*24*60,size=len(reg)),unit='m')+pd.Timedelta(hours=9)
reg['registered_on']=pd.Series(rt).where(ok,pd.NaT)
reg['exam_cycle_id']=cmap[(2026,'EndSem')]
reg.insert(0,'registration_id',np.arange(1,len(reg)+1))
reg=reg[['registration_id','student_number','course_id','exam_cycle_id','attendance_percentage','registration_status','blocked_reason','registered_on']]
reg.to_csv(OUT+'exam_registration.csv',index=False,date_format='%Y-%m-%d %H:%M:%S')
ht=reg.groupby('student_number').agg(courses_registered=('registration_status',lambda s:(s=='Registered').sum()),courses_blocked=('registration_status',lambda s:(s=='Blocked').sum())).reset_index()
ht['exam_cycle_id']=cmap[(2026,'EndSem')]
ht['status']=np.where(ht.courses_registered>0,'Pending Issue','Withheld')
ht['hall_ticket_no']=np.where(ht.courses_registered>0,'HT2627-'+ht.student_number.str[3:],'')
ht['issued_on']=''
ht.insert(0,'hall_ticket_id',np.arange(1,len(ht)+1))
ht=ht[['hall_ticket_id','student_number','exam_cycle_id','hall_ticket_no','courses_registered','courses_blocked','status','issued_on']]
ht.to_csv(OUT+'hall_tickets.csv',index=False)
for n,d in [('cycles',cyc),('schedule',sched),('scheme',sch),('marks',mk),('course_result',cr_out),('semester_result',sr),('cgpa',cg),('registration',reg),('hall_tickets',ht)]:
    print(n,len(d))
