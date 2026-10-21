import numpy as np, pandas as pd, re, math, datetime as dt, os
rng = np.random.default_rng(2026)
UP=os.environ.get('IN_DIR','/mnt/user-data/uploads/'); OUT=os.environ.get('OUT_DIR','/mnt/user-data/outputs/attendance_dataset/')
ACAD_YEAR='2026-27'; TERM_START=dt.date(2026,8,3); DATA_UPTO=dt.date(2026,10,14)
HOLIDAYS={dt.date(2026,9,14),dt.date(2026,10,2)}
CANCEL_P=0.02

# ---------- load ----------
st=pd.read_csv(UP+'students.csv',encoding='cp1252')
st=st[st.status=='Active'].copy()
st['adm_year']=st.admission_number.str[3:7].astype(int)
st['year_of_study']=st.adm_year.map({2026:1,2025:2,2024:3,2023:4})
st['semester']=2*st.year_of_study-1
fx=pd.ExcelFile(UP+'faculty_dataset__1_.xlsx')
fac=fx.parse('Faculty'); crs=fx.parse('Courses'); dep=fx.parse('Departments')
assert set(st.dept_id)<=set(dep.Department_ID)

# ---------- course classification & year mapping ----------
crs['is_tutorial']=crs.Course_Name.str.contains('Tutorial',case=False).astype(int)
crs['course_type']=np.where(crs.Course_Name.str.contains(r'\bLab\b|Workshop',case=False,regex=True),'Lab','Theory')
Y1_KEYS=r'Basic|Workshop|Essentials|Computing|Tools|Surveying|CAD'
year={}
for d,g in crs.groupby('Department_ID'):
    labs=g[g.course_type=='Lab'].sort_values('Course_ID')
    y1=labs[labs.Course_Name.str.contains(Y1_KEYS,regex=True)]
    if y1.empty: y1=labs.iloc[:1]
    for c in y1.Course_ID: year[c]=1
    rest=labs[~labs.Course_ID.isin(y1.Course_ID)].Course_ID.tolist()
    for yr,chunk in zip([2,3,4],np.array_split(rest,3)):
        for c in chunk: year[int(c)]=yr
    th=g[(g.course_type=='Theory')&(g.is_tutorial==0)].sort_values('Course_ID')
    for yr,chunk in zip([1,2,3,4],np.array_split(th.Course_ID.values,4)):
        for c in chunk: year[int(c)]=yr
    for _,r in g[g.is_tutorial==1].iterrows():
        base=r.Course_Name.replace(' Tutorial','').strip()
        m=g[g.Course_Name==base]
        year[int(r.Course_ID)]=year[int(m.Course_ID.iloc[0])] if len(m) else 2
crs['year_of_study']=crs.Course_ID.map(year).astype(int)
crs['semester']=2*crs.year_of_study-1
crs['sessions_per_week']=np.where(crs.course_type=='Lab',1,np.where(crs.is_tutorial==1,1,3))
crs['session_duration_hrs']=np.where(crs.course_type=='Lab',2.0,1.0)
crs['min_attendance_pct']=75
course_cfg=crs.rename(columns={'Course_ID':'course_id','Course_Name':'course_name','Department_ID':'department_id'})[
 ['course_id','course_name','department_id','course_type','is_tutorial','year_of_study','semester','sessions_per_week','session_duration_hrs','min_attendance_pct']]
course_cfg.to_csv(OUT+'course_attendance_config.csv',index=False)

# ---------- divisions / batches / student mapping ----------
div_rows=[];bat_rows=[];map_rows=[];div_id=0;bat_id=0
for (d,y),g in st.groupby(['dept_id','year_of_study']):
    g=g.sort_values('student_number'); n=len(g); nd=math.ceil(n/75)
    for k,chunk in enumerate(np.array_split(g.student_number.values,nd)):
        div_id+=1; code=f"{d}-Y{y}-{chr(65+k)}"
        div_rows.append((div_id,code,d,y,2*y-1,ACAD_YEAR,len(chunk),k))
        for b,bchunk in enumerate(np.array_split(chunk,3)):
            bat_id+=1; bcode=f"{code}-B{b+1}"
            bat_rows.append((bat_id,bcode,div_id,len(bchunk)))
            for s in bchunk: map_rows.append((s,div_id,bat_id,d,y,2*y-1,ACAD_YEAR))
div=pd.DataFrame(div_rows,columns=['division_id','division_code','department_id','year_of_study','semester','academic_year','strength','_k'])
bat=pd.DataFrame(bat_rows,columns=['batch_id','batch_code','division_id','strength'])
mp=pd.DataFrame(map_rows,columns=['student_number','division_id','batch_id','department_id','year_of_study','semester','academic_year'])
mp['roll_no']=mp.groupby('division_id').cumcount()+1
mp=mp[['student_number','department_id','year_of_study','semester','academic_year','division_id','batch_id','roll_no']]
div.drop(columns='_k').to_csv(OUT+'attendance_divisions.csv',index=False)
bat.to_csv(OUT+'attendance_batches.csv',index=False)
mp.to_csv(OUT+'student_section_mapping.csv',index=False)
kmap=dict(zip(div.division_id,div._k))

# ---------- calendar ----------
days=[]; d0=TERM_START
while d0<=DATA_UPTO:
    if d0.weekday()<5 and d0 not in HOLIDAYS: days.append(d0)
    d0+=dt.timedelta(days=1)
W=(DATA_UPTO-TERM_START).days//7+1
def sched(offsets):
    return [d for d in days if d.weekday() in offsets]
dow_eff={0:-0.15,1:0.0,2:0.05,3:0.0,4:-0.25}

# ---------- teaching assignments ----------
asg=[];aid=0
batches_by_div=bat.groupby('division_id').batch_id.apply(list).to_dict()
for d,gd in div.groupby('department_id'):
    fl=fac[fac.Department_ID==d].Faculty_ID.tolist(); load={f:0.0 for f in fl}; member={f:0 for f in fl}
    cd=crs[crs.Department_ID==d].sort_values('Course_ID'); pool={}
    for _,c in cd.iterrows():
        cand=sorted([f for f in fl if f!=c.Course_Coordinator_ID],key=lambda f:(member[f],rng.random()))[:5]
        pool[c.Course_ID]=[c.Course_Coordinator_ID]+cand
        for f in pool[c.Course_ID]: member[f]+=1
    for _,dv in gd.sort_values('division_id').iterrows():
        for _,c in cd[cd.year_of_study==dv.year_of_study].iterrows():
            hrs=c.sessions_per_week*c.session_duration_hrs
            units=[(None,)] if c.course_type=='Theory' else [(b,) for b in batches_by_div[dv.division_id]]
            for (b,) in units:
                f=min(pool[c.Course_ID],key=lambda f:(load[f],rng.random())); load[f]+=hrs; aid+=1
                asg.append((aid,ACAD_YEAR,int(dv.semester),int(c.Course_ID),int(f),int(dv.division_id),b,
                            'Lecture' if c.course_type=='Theory' else 'Lab',int(c.sessions_per_week)))
asg=pd.DataFrame(asg,columns=['assignment_id','academic_year','semester','course_id','faculty_id','division_id','batch_id','session_type','weekly_sessions'])
asg['batch_id']=asg.batch_id.astype('Int64')
asg.to_csv(OUT+'teaching_assignments.csv',index=False)

# ---------- sessions, records, summary ----------
cfg=course_cfg.set_index('course_id')
dept_of_div=dict(zip(div.division_id,div.department_id))
theory_order={}
for dvid,gdv in asg[asg.session_type=='Lecture'].groupby('division_id'):
    theory_order[dvid]=sorted(gdv.course_id.tolist())
lab_order={}
for dvid,gdv in asg[asg.session_type=='Lab'].groupby('division_id'):
    lab_order[dvid]=sorted(set(gdv.course_id.tolist()))
stu_by_div=mp.groupby('division_id').student_number.apply(np.array).to_dict()
stu_by_bat=mp.groupby('batch_id').student_number.apply(np.array).to_dict()
base_p=np.clip(rng.beta(9,2,size=len(mp)),0.05,0.995)
base_logit=dict(zip(mp.student_number,np.log(base_p/(1-base_p))))
lg=lambda x:1/(1+np.exp(-x))

sess_rows=[];sum_rows=[];sid=0;rid=0;sumid=0
rec_buf={d:[] for d in div.department_id.unique()}
for r in asg.itertuples(index=False):
    c=cfg.loc[r.course_id]; k=kmap[r.division_id]
    if r.session_type=='Lecture':
        j=theory_order[r.division_id].index(r.course_id)
        offs={(j+2*i+k)%5 for i in range(3)} if c.is_tutorial==0 else {(j+k)%5}
        studs=stu_by_div[r.division_id]
    else:
        l=lab_order[r.division_id].index(r.course_id)
        bpos=batches_by_div[r.division_id].index(r.batch_id)
        offs={(2*bpos+l+k)%5}; studs=stu_by_bat[r.batch_id]
    ds=sched(offs); m=len(ds)
    cancelled=rng.random(m)<CANCEL_P
    ids=np.arange(sid+1,sid+m+1); sid+=m
    for i,(dd,cx) in enumerate(zip(ds,cancelled)):
        if cx: ts=''
        else:
            ts=f"{dd.isoformat()} {int(rng.integers(10,18)):02d}:{int(rng.integers(0,60)):02d}:{int(rng.integers(0,60)):02d}"
        sess_rows.append((int(ids[i]),r.assignment_id,r.course_id,r.faculty_id,r.division_id,
            None if pd.isna(r.batch_id) else int(r.batch_id),r.session_type,dd.isoformat(),i+1,float(c.session_duration_hrs),
            'Cancelled' if cx else 'Conducted',r.faculty_id,ts))
    keep=~cancelled; kd=[d for d,x in zip(ds,keep) if x]; kids=ids[keep]; mm=len(kd)
    if mm==0: continue
    n=len(studs)
    bl=np.array([base_logit[s] for s in studs])[:,None]
    shift=rng.normal(0.35 if r.session_type=='Lab' else 0.0,0.35,size=n)[:,None]
    wk=np.array([0.3-0.45*(((d-TERM_START).days//7)/(W-1)) for d in kd])+np.array([dow_eff[d.weekday()] for d in kd])
    P=rng.random((n,mm))<lg(bl+shift+wk[None,:])
    att=P.sum(1); dept=dept_of_div[r.division_id]
    rec_buf[dept].append((np.repeat(kids,n),np.tile(studs,mm),np.where(P.T.reshape(-1),'P','A')))
    lastu=max(x[12] for x in sess_rows[-m:] if x[12]) if mm else ''
    for s,a in zip(studs,att):
        sumid+=1
        sum_rows.append((sumid,s,int(r.course_id),ACAD_YEAR,int(r.semester),c.course_type,mm,int(a),mm-int(a),round(100*a/mm,2),
                         'Eligible' if 100*a/mm>=75 else 'Shortage',lastu))
sess=pd.DataFrame(sess_rows,columns=['session_id','assignment_id','course_id','faculty_id','division_id','batch_id','session_type','session_date','session_number','duration_hrs','session_status','marked_by','marked_at'])
sess=sess[['session_id','assignment_id','session_type','session_date','session_number','duration_hrs','session_status','marked_by','marked_at']]
sess.to_csv(OUT+'attendance_sessions.csv',index=False)
summ=pd.DataFrame(sum_rows,columns=['summary_id','student_number','course_id','academic_year','semester','course_type','total_lectures','lectures_attended','lectures_absent','attendance_percentage','eligibility_status','last_updated'])
summ.to_csv(OUT+'attendance_summary.csv',index=False)
# records, split by department (global attendance_id)
rid=0; tot=0
for d,buf in rec_buf.items():
    sids=np.concatenate([b[0] for b in buf]); stu=np.concatenate([b[1] for b in buf]); stt=np.concatenate([b[2] for b in buf])
    df=pd.DataFrame({'attendance_id':np.arange(rid+1,rid+len(sids)+1),'session_id':sids,'student_number':stu,'status':stt})
    rid+=len(df); tot+=len(df)
    df.to_csv(OUT+f'attendance_records_{d}.csv',index=False)
    print(d,len(df))
print('total records',tot,'sessions',len(sess),'assignments',len(asg),'summary',len(summ),'students',len(mp))
