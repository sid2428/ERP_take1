/** Academic and curriculum queries for Group 2 (T3). */
import { query } from '../db.js';

export interface ProgramPrereqEdge {
  from_course_id: number;
  from_course_code: string;
  from_course_name: string;
  from_semester: number;
  to_course_id: number;
  to_course_code: string;
  to_course_name: string;
  to_semester: number;
  min_grade: string;
}

export interface GraphNode {
  courseId: number;
  code: string;
  name: string;
  credits: number;
  semester: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphEdge {
  fromCode: string;
  toCode: string;
  minGrade: string;
  d: string;
}

export interface GraphColumn {
  semester: number;
  x: number;
  width: number;
}

export interface PrereqGraphData {
  width: number;
  height: number;
  columns: GraphColumn[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SemesterWithCourses {
  no: number;
  credits: number;
  courses: {
    course_id: number;
    course_code: string;
    course_name: string;
    credits: number;
  }[];
}

/** Fetches prerequisite edges where both courses are placed in the given program. */
export function getProgramPrerequisites(programId: string): Promise<ProgramPrereqEdge[]> {
  return query<ProgramPrereqEdge>(`
    SELECT cp.prereq_course_id AS from_course_id,
           c1.course_code      AS from_course_code,
           c1.course_name      AS from_course_name,
           pc1.semester_no     AS from_semester,
           cp.course_id        AS to_course_id,
           c2.course_code      AS to_course_code,
           c2.course_name      AS to_course_name,
           pc2.semester_no     AS to_semester,
           cp.min_grade
    FROM course_prerequisite cp
    JOIN program_curriculum pc1 ON pc1.course_id = cp.prereq_course_id AND pc1.program_id = $1
    JOIN course c1 ON c1.course_id = cp.prereq_course_id
    JOIN program_curriculum pc2 ON pc2.course_id = cp.course_id AND pc2.program_id = $1
    JOIN course c2 ON c2.course_id = cp.course_id
    ORDER BY pc1.semester_no, c1.course_code, pc2.semester_no, c2.course_code
  `, [programId]);
}

/** Builds coordinates and SVG path data for a program's prerequisite graph. */
export function buildPrereqGraph(
  semesters: SemesterWithCourses[],
  prereqs: ProgramPrereqEdge[],
): PrereqGraphData {
  const COL_PITCH = 180;
  const NODE_W = 130;
  const NODE_H = 46;
  const ROW_GAP = 16;
  const TOP_OFFSET = 48;
  const LEFT_OFFSET = 24;
  const BOTTOM_OFFSET = 24;

  const nodes: GraphNode[] = [];
  const nodesMap = new Map<number, GraphNode>();
  const columns: GraphColumn[] = [];

  let maxCoursesInCol = 0;

  for (let sIdx = 0; sIdx < semesters.length; sIdx++) {
    const sem = semesters[sIdx]!;
    const colX = LEFT_OFFSET + sIdx * COL_PITCH;
    columns.push({ semester: sem.no, x: colX, width: NODE_W });

    if (sem.courses.length > maxCoursesInCol) {
      maxCoursesInCol = sem.courses.length;
    }

    for (let cIdx = 0; cIdx < sem.courses.length; cIdx++) {
      const c = sem.courses[cIdx]!;
      const nodeY = TOP_OFFSET + cIdx * (NODE_H + ROW_GAP);
      const node: GraphNode = {
        courseId: c.course_id,
        code: c.course_code,
        name: c.course_name,
        credits: Number(c.credits),
        semester: sem.no,
        x: colX,
        y: nodeY,
        width: NODE_W,
        height: NODE_H,
      };
      nodes.push(node);
      nodesMap.set(c.course_id, node);
    }
  }

  const edges: GraphEdge[] = [];
  for (const p of prereqs) {
    const src = nodesMap.get(p.from_course_id);
    const dst = nodesMap.get(p.to_course_id);
    if (!src || !dst) continue;

    const x1 = src.x + src.width;
    const y1 = src.y + src.height / 2;
    const x2 = dst.x;
    const y2 = dst.y + dst.height / 2;

    let d: string;
    if (x2 > x1) {
      const dx = x2 - x1;
      const c1x = x1 + dx * 0.45;
      const c2x = x2 - dx * 0.45;
      d = `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
    } else {
      d = `M ${x1} ${y1} C ${x1 + 35} ${y1 - 25}, ${x2 - 35} ${y2 - 25}, ${x2} ${y2}`;
    }

    edges.push({
      fromCode: p.from_course_code,
      toCode: p.to_course_code,
      minGrade: p.min_grade,
      d,
    });
  }

  const height = Math.max(140, TOP_OFFSET + maxCoursesInCol * (NODE_H + ROW_GAP) + BOTTOM_OFFSET);
  const width = Math.max(340, LEFT_OFFSET + semesters.length * COL_PITCH + 20);

  return {
    width,
    height,
    columns,
    nodes,
    edges,
  };
}
