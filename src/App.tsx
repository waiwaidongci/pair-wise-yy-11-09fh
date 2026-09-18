import { useEffect, useMemo, useState } from "react";
import "./styles.css";

/* ===================== 领域模型 ===================== */

type Stage = "registered" | "rechecking" | "approved" | "rejected" | "superseded";

type Disposal = "qualified" | "drying" | "downgrade" | "scrap";

interface RecheckRecord {
  inspector: string; // 检测人
  moisture: number; // 复测含水率
  germination: number; // 复测发芽率
  conclusion: Disposal; // 处置结论
  targetLocation: string; // 复检确认/调整后的库位
  note?: string;
  at: string; // ISO 时间
}

interface Application {
  id: string;
  batchNo: string; // 批次号
  crop: string; // 作物/材料
  source: string; // 来源库
  sealNo: string; // 封条编号
  germination: number; // 发芽率 %
  moisture: number; // 含水率 %
  vigorTestDate: string; // 活力检测日期
  targetLocation: string; // 目标库位
  stage: Stage;
  fingerprint: string; // 首次检测结果指纹
  registeredAt: string;
  approvedAt?: string;
  orderNo?: string; // 调拨单号
  recheck?: RecheckRecord;
  recheckReasons: string[]; // 触发复检的原因
  supersedeReason?: string; // 失效原因
  history: { at: string; text: string }[];
  duplicateCount: number; // 同一封条重复申请次数
}

interface PersistShape {
  version: number;
  seq: number;
  applications: Application[];
}

/* ===================== 常量与规则 ===================== */

const STORAGE_KEY = "grb-transfer-review-v1";
const MOISTURE_LIMIT = 13; // 含水率红线
const VIGOR_LIMIT_DAYS = 90; // 活力检测有效期

const STAGE_META: Record<Stage, { label: string; tone: string }> = {
  registered: { label: "待复核", tone: "info" },
  rechecking: { label: "复检中", tone: "warn" },
  approved: { label: "已批准", tone: "ok" },
  rejected: { label: "处置退回", tone: "bad" },
  superseded: { label: "已失效", tone: "muted" },
};

const DISPOSAL_LABEL: Record<Disposal, string> = {
  qualified: "合格通过",
  drying: "干燥处理后重检",
  downgrade: "降级使用",
  scrap: "报废销毁",
};

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部申请" },
  { key: "registered", label: "待复核" },
  { key: "rechecking", label: "复检中" },
  { key: "approved", label: "已批准" },
  { key: "rejected", label: "处置退回" },
  { key: "superseded", label: "已失效" },
  { key: "duplicates", label: "重复封条" },
];

// 全部库位；occupied=true 表示被其他在储批次基础占用（非本台调拨单）
const LOCATIONS: { code: string; zone: string; occupied: boolean }[] = [
  { code: "A库-长期-01", zone: "A库 · 长期库(-18℃)", occupied: false },
  { code: "A库-长期-02", zone: "A库 · 长期库(-18℃)", occupied: false },
  { code: "A库-长期-03", zone: "A库 · 长期库(-18℃)", occupied: true },
  { code: "B库-中期-01", zone: "B库 · 中期库(-4℃)", occupied: false },
  { code: "B库-中期-02", zone: "B库 · 中期库(-4℃)", occupied: true },
  { code: "B库-中期-03", zone: "B库 · 中期库(-4℃)", occupied: false },
  { code: "C库-短期-01", zone: "C库 · 短期库(4℃)", occupied: false },
  { code: "C库-短期-02", zone: "C库 · 短期库(4℃)", occupied: false },
];

/* ===================== 工具函数 ===================== */

const pad = (n: number) => String(n).padStart(2, "0");

function nowIso() {
  return new Date().toISOString();
}

function fmt(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function fmtDate(iso: string) {
  return iso.slice(0, 10);
}

function daysSince(dateStr: string) {
  const then = new Date(dateStr + "T00:00:00").getTime();
  return Math.floor((Date.now() - then) / 86400000);
}

// 首次检测结果指纹：同一封条 + 完全相同的检测结果 = 沿用首次结果
function fingerprint(sealNo: string, germination: number, moisture: number, vigor: string) {
  return `${sealNo.trim()}|${germination}|${moisture}|${vigor}`;
}

// 计算一条登记数据触发复检的原因
function evaluateRecheck(
  moisture: number,
  vigorTestDate: string,
  targetLocation: string,
  occupiedLocations: Set<string>
): string[] {
  const reasons: string[] = [];
  if (moisture > MOISTURE_LIMIT) {
    reasons.push(`含水率 ${moisture}% 高于 ${MOISTURE_LIMIT}%`);
  }
  const age = daysSince(vigorTestDate);
  if (age > VIGOR_LIMIT_DAYS) {
    reasons.push(`活力检测已 ${age} 天，超过 ${VIGOR_LIMIT_DAYS} 天有效期`);
  }
  if (occupiedLocations.has(targetLocation)) {
    reasons.push(`目标库位 ${targetLocation} 已被占用`);
  }
  return reasons;
}

// 当前有效批准所占用的库位（基础占用之外的动态占用）
function orderOccupancy(apps: Application[]) {
  const byLocation = new Map<string, string>();
  for (const a of apps) {
    if (a.stage === "approved" && a.recheck?.targetLocation) {
      byLocation.set(a.recheck.targetLocation, a.id);
    } else if (a.stage === "approved") {
      byLocation.set(a.targetLocation, a.id);
    }
  }
  return byLocation;
}

function isActive(app: Application) {
  return app.stage === "registered" || app.stage === "rechecking" || app.stage === "approved";
}

/* ===================== 种子数据 ===================== */

const today = new Date();
function daysAgo(n: number) {
  const d = new Date(today.getTime() - n * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seedState(): PersistShape {
  return {
    version: 1,
    seq: 5,
    applications: [
      {
        id: "TRF-0001",
        batchNo: "ZM2026-0118",
        crop: "玉米 · 郑单958",
        source: "海南繁种库",
        sealNo: "SEAL-88012",
        germination: 96,
        moisture: 11.2,
        vigorTestDate: daysAgo(28),
        targetLocation: "A库-长期-01",
        stage: "approved",
        fingerprint: fingerprint("SEAL-88012", 96, 11.2, daysAgo(28)),
        registeredAt: new Date(today.getTime() - 2 * 86400000).toISOString(),
        approvedAt: new Date(today.getTime() - 2 * 86400000 + 3600_000).toISOString(),
        orderNo: "DB-20260916-0001",
        recheckReasons: [],
        history: [
          { at: new Date(today.getTime() - 2 * 86400000).toISOString(), text: "登记调拨申请，检测结果正常" },
          {
            at: new Date(today.getTime() - 2 * 86400000 + 3600_000).toISOString(),
            text: "复核通过，占用封条 SEAL-88012 与库位 A库-长期-01，生成调拨单 DB-20260916-0001",
          },
        ],
        duplicateCount: 0,
      },
      {
        id: "TRF-0002",
        batchNo: "SD2026-0341",
        crop: "水稻 · 南粳46",
        source: "南京中期库",
        sealNo: "SEAL-77205",
        germination: 88,
        moisture: 14.6,
        vigorTestDate: daysAgo(102),
        targetLocation: "B库-中期-02",
        stage: "rechecking",
        fingerprint: fingerprint("SEAL-77205", 88, 14.6, daysAgo(102)),
        registeredAt: new Date(today.getTime() - 86400000).toISOString(),
        recheckReasons: [
          `含水率 14.6% 高于 ${MOISTURE_LIMIT}%`,
          `活力检测已 102 天，超过 ${VIGOR_LIMIT_DAYS} 天有效期`,
          `目标库位 B库-中期-02 已被占用`,
        ],
        history: [
          {
            at: new Date(today.getTime() - 86400000).toISOString(),
            text: "登记调拨申请；含水率超标、活力过期、目标库位占用，强制转入复检",
          },
        ],
        duplicateCount: 0,
      },
      {
        id: "TRF-0003",
        batchNo: "XM2026-0076",
        crop: "小麦 · 济麦22",
        source: "济南短期库",
        sealNo: "SEAL-65530",
        germination: 92,
        moisture: 11.8,
        vigorTestDate: daysAgo(35),
        targetLocation: "C库-短期-01",
        stage: "registered",
        fingerprint: fingerprint("SEAL-65530", 92, 11.8, daysAgo(35)),
        registeredAt: nowIso(),
        recheckReasons: [],
        history: [{ at: nowIso(), text: "登记调拨申请，等待复核" }],
        duplicateCount: 0,
      },
      {
        id: "TRF-0004",
        batchNo: "DD2026-0019",
        crop: "大豆 · 中黄39",
        source: "哈尔滨备份库",
        sealNo: "SEAL-51088",
        germination: 90,
        moisture: 12.0,
        vigorTestDate: daysAgo(60),
        targetLocation: "B库-中期-03",
        stage: "superseded",
        fingerprint: fingerprint("SEAL-51088", 90, 12.0, daysAgo(60)),
        registeredAt: new Date(today.getTime() - 6 * 86400000).toISOString(),
        approvedAt: new Date(today.getTime() - 5 * 86400000).toISOString(),
        orderNo: "DB-20260912-0004",
        recheckReasons: [],
        supersedeReason: "封条 SEAL-51088 产生新检测结果（含水率 12.0%→13.8%），旧批准立即失效",
        history: [
          { at: new Date(today.getTime() - 6 * 86400000).toISOString(), text: "登记调拨申请" },
          {
            at: new Date(today.getTime() - 5 * 86400000).toISOString(),
            text: "复核通过，生成调拨单 DB-20260912-0004",
          },
          {
            at: new Date(today.getTime() - 3600_000).toISOString(),
            text: "新检测登记：含水率由 12.0% 变为 13.8%，旧批准立即失效，释放封条与库位，调拨单作废",
          },
        ],
        duplicateCount: 0,
      },
    ],
  };
}

function loadState(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.applications)) return parsed;
    }
  } catch {
    /* 损坏的本地数据回落到种子 */
  }
  return seedState();
}

/* ===================== 主组件 ===================== */

interface FormState {
  batchNo: string;
  crop: string;
  source: string;
  sealNo: string;
  germination: string;
  moisture: string;
  vigorTestDate: string;
  targetLocation: string;
}

const EMPTY_FORM: FormState = {
  batchNo: "",
  crop: "",
  source: "",
  sealNo: "",
  germination: "",
  moisture: "",
  vigorTestDate: "",
  targetLocation: "",
};

function App() {
  const [state, setState] = useState<PersistShape>(loadState);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [filter, setFilter] = useState("all");
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5200);
    return () => clearTimeout(t);
  }, [notice]);

  /* ---------- 派生数据（批次、库位、历史始终一致） ---------- */

  const occupiedByOrders = useMemo(() => orderOccupancy(state.applications), [state.applications]);

  // 库位是否被占用 = 基础在储占用 ∪ 有效调拨单占用
  const occupiedLocations = useMemo(() => {
    const set = new Set(LOCATIONS.filter((l) => l.occupied).map((l) => l.code));
    occupiedByOrders.forEach((id, loc) => set.add(loc));
    return set;
  }, [occupiedByOrders]);

  const metrics = useMemo(() => {
    const waiting = state.applications.filter((a) => a.stage === "registered").length;
    const rechecking = state.applications.filter((a) => a.stage === "rechecking").length;
    const validOrders = state.applications.filter((a) => a.stage === "approved").length;
    const rate = Math.round((occupiedLocations.size / LOCATIONS.length) * 100);
    return { waiting, rechecking, validOrders, rate };
  }, [state.applications, occupiedLocations]);

  const visibleApplications = useMemo(() => {
    const list = [...state.applications].sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
    if (filter === "all") return list;
    if (filter === "duplicates") return list.filter((a) => a.duplicateCount > 0);
    return list.filter((a) => a.stage === filter);
  }, [state.applications, filter]);

  const activeSeals = useMemo(() => {
    const map = new Map<string, Application>();
    state.applications
      .filter((a) => isActive(a))
      .forEach((a) => map.set(a.sealNo, a));
    return map;
  }, [state.applications]);

  /* ---------- 表单实时规则提示 ---------- */

  const parsedMoisture = parseFloat(form.moisture);
  const liveReasons = useMemo(() => {
    if (!form.targetLocation || !form.vigorTestDate || Number.isNaN(parsedMoisture)) return [];
    return evaluateRecheck(parsedMoisture, form.vigorTestDate, form.targetLocation, occupiedLocations);
  }, [form.targetLocation, form.vigorTestDate, form.moisture, parsedMoisture, occupiedLocations]);

  /* ---------- 登记申请 ---------- */

  function setField<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function registerApplication() {
    const germination = parseFloat(form.germination);
    const moisture = parseFloat(form.moisture);

    if (!form.batchNo.trim() || !form.sealNo.trim() || !form.vigorTestDate || !form.targetLocation) {
      setNotice({ tone: "bad", text: "请完整填写批次号、封条编号、活力检测日期和目标库位。" });
      return;
    }
    if (Number.isNaN(germination) || Number.isNaN(moisture)) {
      setNotice({ tone: "bad", text: "发芽率和含水率必须是数值。" });
      return;
    }
    if (germination < 0 || germination > 100 || moisture < 0 || moisture > 100) {
      setNotice({ tone: "bad", text: "发芽率与含水率需在 0–100 之间。" });
      return;
    }
    if (daysSince(form.vigorTestDate) < 0) {
      setNotice({ tone: "bad", text: "活力检测日期不能晚于今天。" });
      return;
    }

    const fp = fingerprint(form.sealNo, germination, moisture, form.vigorTestDate);
    const prior = state.applications.find(
      (a) => a.sealNo.trim() === form.sealNo.trim() && a.fingerprint === fp && isActive(a)
    );

    // 规则：同一封条重复申请沿用首次结果
    if (prior) {
      const ts = nowIso();
      setState((s) => ({
        ...s,
        applications: s.applications.map((a) =>
          a.id === prior.id
            ? {
                ...a,
                duplicateCount: a.duplicateCount + 1,
                history: [
                  ...a.history,
                  {
                    at: ts,
                    text: `批次 ${form.batchNo} 使用封条 ${a.sealNo} 重复申请：检测结果与首次完全一致，沿用首次结果，不重复占用资源`,
                  },
                ],
              }
            : a
        ),
      }));
      setNotice({
        tone: "warn",
        text: `封条 ${form.sealNo} 的检测结果与首次申请（${prior.batchNo}）完全一致，已沿用首次结果，未生成新单。`,
      });
      setHighlightId(prior.id);
      setForm(EMPTY_FORM);
      return;
    }

    const seq = state.seq + 1;
    const id = `TRF-${pad(seq)}`;
    const ts = nowIso();
    const reasons = evaluateRecheck(moisture, form.vigorTestDate, form.targetLocation, occupiedLocations);
    const forced = reasons.length > 0;

    // 规则：新检测会立即让旧批准/在途申请失效（同一封条、结果不同）
    const sameSeal = state.applications.filter(
      (a) => a.sealNo.trim() === form.sealNo.trim() && isActive(a)
    );

    const newApp: Application = {
      id,
      batchNo: form.batchNo.trim(),
      crop: form.crop.trim() || "未命名材料",
      source: form.source.trim() || "—",
      sealNo: form.sealNo.trim(),
      germination,
      moisture,
      vigorTestDate: form.vigorTestDate,
      targetLocation: form.targetLocation,
      stage: forced ? "rechecking" : "registered",
      fingerprint: fp,
      registeredAt: ts,
      recheckReasons: reasons,
      history: [
        {
          at: ts,
          text: forced
            ? `登记调拨申请；${reasons.join("；")}，只能转入复检`
            : "登记调拨申请，检测结果正常，等待复核",
        },
      ],
      duplicateCount: 0,
    };

    setState((s) => ({
      ...s,
      seq,
      applications: [
        ...s.applications.map((a) => {
          if (!sameSeal.some((x) => x.id === a.id)) return a;
          const wasApproved = a.stage === "approved";
          return {
            ...a,
            stage: "superseded" as Stage,
            supersedeReason: `封条 ${a.sealNo} 产生新检测结果，旧${
              wasApproved ? "批准立即失效，调拨单作废" : "在途申请作废"
            }，封条与库位占用同步释放`,
            orderNo: wasApproved ? a.orderNo : undefined,
            history: [
              ...a.history,
              {
                at: ts,
                text: `批次 ${newApp.batchNo} 对封条 ${a.sealNo} 提交了新检测结果（含水率 ${a.moisture}%→${moisture}%、发芽率 ${a.germination}%→${germination}%、活力日期 ${a.vigorTestDate}→${form.vigorTestDate}），本单立即失效，封条与库位占用同步释放`,
              },
            ],
          };
        }),
        newApp,
      ],
    }));

    if (sameSeal.length > 0) {
      setNotice({
        tone: "bad",
        text: `检测到封条 ${form.sealNo} 的新检测结果：${sameSeal
          .map((a) => `${a.id}（${a.stage === "approved" ? "已批准" : "在途"}）`)
          .join("、")} 已立即失效，占用已释放，新申请${forced ? "只能复检" : "等待复核"}。`,
      });
    } else if (forced) {
      setNotice({ tone: "warn", text: `申请 ${id} 命中复检规则（${reasons.join("；")}），已转入复检。` });
    } else {
      setNotice({ tone: "ok", text: `申请 ${id} 登记成功，检测结果正常，可直接复核批准。` });
    }
    setHighlightId(id);
    setForm(EMPTY_FORM);
  }

  /* ---------- 直接批准（仅无任何违规的待复核单可用） ---------- */

  function approve(app: Application) {
    const occ = new Set([...occupiedLocations]);
    occ.delete(app.targetLocation); // 批准的是本单自己的库位
    const guard = evaluateRecheck(app.moisture, app.vigorTestDate, app.targetLocation, occ);
    if (guard.length > 0) {
      setNotice({ tone: "bad", text: `当前状态不允许直接批准：${guard.join("；")}。请走复检。` });
      return;
    }
    const ts = nowIso();
    const orderNo = `DB-${fmtDate(ts).replace(/-/g, "")}-${app.id.slice(4)}`;
    setState((s) => ({
      ...s,
      applications: s.applications.map((a) =>
        a.id === app.id
          ? {
              ...a,
              stage: "approved",
              approvedAt: ts,
              orderNo,
              history: [
                ...a.history,
                {
                  at: ts,
                  text: `复核通过：同时占用封条 ${a.sealNo} 与库位 ${a.targetLocation}，生成调拨单 ${orderNo}`,
                },
              ],
            }
          : a
      ),
    }));
    setNotice({ tone: "ok", text: `${app.id} 已批准，调拨单 ${orderNo} 已生成，封条与库位均已占用。` });
  }

  /* ---------- 提交复检 ---------- */

  function submitRecheck(app: Application, rec: Omit<RecheckRecord, "at">) {
    const ts = nowIso();

    if (rec.conclusion === "qualified") {
      if (rec.moisture > MOISTURE_LIMIT) {
        setNotice({ tone: "bad", text: `复测含水率 ${rec.moisture}% 仍高于 ${MOISTURE_LIMIT}%，不能判定合格通过。` });
        return false;
      }
      // 复检中的工单不持有任何库位：库位被在储批次或其他调拨单占用即不能通过
      const holder = occupiedByOrders.get(rec.targetLocation);
      if (occupiedLocations.has(rec.targetLocation) && holder !== app.id) {
        setNotice({ tone: "bad", text: `库位 ${rec.targetLocation} 当前已占用，请改选空闲库位后再合格通过。` });
        return false;
      }

      const orderNo = `DB-${fmtDate(ts).replace(/-/g, "")}-${app.id.slice(4)}`;
      setState((s) => ({
        ...s,
        applications: s.applications.map((a) =>
          a.id === app.id
            ? {
                ...a,
                stage: "approved",
                approvedAt: ts,
                orderNo,
                targetLocation: rec.targetLocation,
                recheck: { ...rec, at: ts },
                history: [
                  ...a.history,
                  {
                    at: ts,
                    text: `复检合格（检测人：${rec.inspector}，复测含水率 ${rec.moisture}%、发芽率 ${rec.germination}%，库位 ${rec.targetLocation}）：同时占用封条与库位，生成调拨单 ${orderNo}`,
                  },
                ],
              }
            : a
        ),
      }));
      setNotice({ tone: "ok", text: `${app.id} 复检合格通过，调拨单 ${orderNo} 已生成。` });
      return true;
    }

    // 非合格结论 → 不占用封条与库位，退回处置
    const label = DISPOSAL_LABEL[rec.conclusion];
    setState((s) => ({
      ...s,
      applications: s.applications.map((a) =>
        a.id === app.id
          ? {
              ...a,
              stage: "rejected",
              recheck: { ...rec, at: ts },
              history: [
                ...a.history,
                {
                  at: ts,
                  text: `复检完成（检测人：${rec.inspector}，复测含水率 ${rec.moisture}%、发芽率 ${rec.germination}%）：处置结论「${label}」，不占用封条与库位${rec.note ? `；${rec.note}` : ""}`,
                },
              ],
            }
          : a
      ),
    }));
    setNotice({ tone: "warn", text: `${app.id} 复检结论为「${label}」，未生成调拨单，资源保持释放。` });
    return true;
  }

  function resetAll() {
    setState(seedState());
    setNotice({ tone: "ok", text: "已恢复演示数据。" });
    setHighlightId(null);
  }

  /* ===================== 渲染 ===================== */

  return (
    <main className="app">
      <section className="hero">
        <p>GRB-62010 · 国家作物种质库 · 跨库调拨业务</p>
        <h1>种质库跨库调拨复核台</h1>
        <span>
          登记发芽率、含水率、封条编号与目标库位；含水率高于 {MOISTURE_LIMIT}%、活力检测超过{" "}
          {VIGOR_LIMIT_DAYS} 天或目标库位已占用时只能转入复检；同一封条重复申请沿用首次结果；复检合格后同时占用封条与库位并生成调拨单；封条一旦出现新检测，旧批准立即失效。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>待复核</small>
          <strong>{metrics.waiting}</strong>
        </article>
        <article>
          <small>复检中</small>
          <strong>{metrics.rechecking}</strong>
        </article>
        <article>
          <small>有效调拨单</small>
          <strong>{metrics.validOrders}</strong>
        </article>
        <article>
          <small>库位占用率</small>
          <strong>{metrics.rate}%</strong>
        </article>
      </section>

      {notice && (
        <div className={`notice ${notice.tone}`}>
          {notice.text}
          <button className="notice-close" onClick={() => setNotice(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}

      <section className="workspace">
        {/* 左侧：筛选 + 库位占用图 */}
        <aside className="panel">
          <h2>业务分类</h2>
          <div className="chips">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                className={filter === item.key ? "chip-active" : ""}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <h2 className="loc-title">目标库位状态</h2>
          <div className="loc-list">
            {LOCATIONS.map((loc) => {
              const orderHolder = occupiedByOrders.get(loc.code);
              const taken = occupiedLocations.has(loc.code);
              return (
                <div key={loc.code} className={`loc-item ${taken ? "taken" : "free"}`}>
                  <div>
                    <b>{loc.code}</b>
                    <small>{loc.zone}</small>
                  </div>
                  <span className="loc-badge">
                    {orderHolder
                      ? `调拨占用 ${orderHolder}`
                      : loc.occupied
                      ? "在储占用"
                      : "空闲"}
                  </span>
                </div>
              );
            })}
          </div>

          <h2 className="loc-title">封条占用（有效批准）</h2>
          <div className="seal-list">
            {state.applications.filter((a) => a.stage === "approved").length === 0 && (
              <p className="muted-text">暂无被占用的封条</p>
            )}
            {state.applications
              .filter((a) => a.stage === "approved")
              .map((a) => (
                <div key={a.id} className="seal-item">
                  <b>{a.sealNo}</b>
                  <span>{a.batchNo} · {a.orderNo}</span>
                </div>
              ))}
          </div>
        </aside>

        {/* 右侧：登记表单 */}
        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>检测登记</p>
              <h2>新增跨库调拨申请</h2>
            </div>
            <button className="primary" onClick={registerApplication}>
              提交登记
            </button>
          </div>

          <div className="field-grid">
            <label>
              <span>批次号 *</span>
              <input value={form.batchNo} onChange={(e) => setField("batchNo", e.target.value)} placeholder="如 ZM2026-0520" />
            </label>
            <label>
              <span>作物 / 材料</span>
              <input value={form.crop} onChange={(e) => setField("crop", e.target.value)} placeholder="如 玉米 · 郑单958" />
            </label>
            <label>
              <span>来源库</span>
              <input value={form.source} onChange={(e) => setField("source", e.target.value)} placeholder="如 青海复份库" />
            </label>
            <label>
              <span>封条编号 *</span>
              <input value={form.sealNo} onChange={(e) => setField("sealNo", e.target.value)} placeholder="如 SEAL-88012" />
            </label>
            <label>
              <span>发芽率（%）</span>
              <input type="number" min={0} max={100} step={0.1} value={form.germination} onChange={(e) => setField("germination", e.target.value)} placeholder="如 95" />
            </label>
            <label>
              <span>含水率（%）{!Number.isNaN(parsedMoisture) && <em className={parsedMoisture > MOISTURE_LIMIT ? "bad-text" : "ok-text"}>{parsedMoisture > MOISTURE_LIMIT ? "超标" : "达标"}</em>}</span>
              <input type="number" min={0} max={100} step={0.1} value={form.moisture} onChange={(e) => setField("moisture", e.target.value)} placeholder={`红线 ${MOISTURE_LIMIT}%`} />
            </label>
            <label>
              <span>活力检测日期 * {form.vigorTestDate && <em className={daysSince(form.vigorTestDate) > VIGOR_LIMIT_DAYS ? "bad-text" : "ok-text"}>{daysSince(form.vigorTestDate)} 天</em>}</span>
              <input type="date" max={daysAgo(0)} value={form.vigorTestDate} onChange={(e) => setField("vigorTestDate", e.target.value)} />
            </label>
            <label>
              <span>目标库位 *</span>
              <select value={form.targetLocation} onChange={(e) => setField("targetLocation", e.target.value)}>
                <option value="">请选择库位</option>
                {LOCATIONS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.code}（{occupiedLocations.has(l.code) ? "已占用" : "空闲"}）
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={`rule-box ${liveReasons.length ? "warn" : "ok"}`}>
            {liveReasons.length === 0 ? (
              <>当前填写内容未命中复检规则，登记后可直接复核批准。</>
            ) : (
              <>
                <b>登记后只能转入复检：</b>
                <ul>{liveReasons.map((r) => <li key={r}>{r}</li>)}</ul>
              </>
            )}
          </div>
          {form.sealNo.trim() && activeSeals.has(form.sealNo.trim()) && (
            <div className="rule-box seal-hint">
              封条 {form.sealNo.trim()} 已有在途/批准记录（{activeSeals.get(form.sealNo.trim())!.id}）：
              检测结果完全一致将沿用首次结果；提交不同结果会立即使旧单失效。
            </div>
          )}
        </section>
      </section>

      {/* 复核队列 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>复核队列</p>
            <h2>批次调拨工单（{visibleApplications.length}）</h2>
          </div>
          <button onClick={resetAll}>恢复演示数据</button>
        </div>
        <div className="queue">
          {visibleApplications.length === 0 && <p className="muted-text">当前分类下没有工单。</p>}
          {visibleApplications.map((app) => (
            <ApplicationCard
              key={app.id}
              app={app}
              highlighted={highlightId === app.id}
              occupiedLocations={occupiedLocations}
              occupiedByOrders={occupiedByOrders}
              onApprove={() => approve(app)}
              onSubmitRecheck={(rec) => submitRecheck(app, rec)}
            />
          ))}
        </div>
      </section>

      {/* 台账：批次 / 库位 / 历史一致 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>调拨台账</p>
            <h2>批次 · 库位 · 历史一致性视图</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>批次号</th>
                <th>封条</th>
                <th>状态</th>
                <th>目标库位</th>
                <th>调拨单号</th>
                <th>登记时间</th>
                <th>重复申请</th>
              </tr>
            </thead>
            <tbody>
              {[...state.applications]
                .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))
                .map((a) => (
                  <tr key={a.id} className={a.stage === "superseded" ? "row-muted" : ""}>
                    <td>{a.batchNo}<small className="cell-sub">{a.crop}</small></td>
                    <td>{a.sealNo}</td>
                    <td><span className={`badge ${STAGE_META[a.stage].tone}`}>{STAGE_META[a.stage].label}</span></td>
                    <td>
                      {a.stage === "approved" ? (a.recheck?.targetLocation ?? a.targetLocation) : a.targetLocation}
                      {a.stage === "approved" && <small className="cell-sub ok-text">封条+库位已占用</small>}
                    </td>
                    <td>{a.orderNo ?? "—"}{a.stage === "superseded" && a.orderNo && <small className="cell-sub bad-text">已作废</small>}</td>
                    <td>{fmt(a.registeredAt)}</td>
                    <td>{a.duplicateCount > 0 ? `${a.duplicateCount} 次（沿用首次结果）` : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

/* ===================== 工单卡片 ===================== */

function ApplicationCard({
  app,
  highlighted,
  occupiedLocations,
  occupiedByOrders,
  onApprove,
  onSubmitRecheck,
}: {
  app: Application;
  highlighted: boolean;
  occupiedLocations: Set<string>;
  occupiedByOrders: Map<string, string>;
  onApprove: () => void;
  onSubmitRecheck: (rec: Omit<RecheckRecord, "at">) => boolean;
}) {
  const [showRecheck, setShowRecheck] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const meta = STAGE_META[app.stage];
  const age = daysSince(app.vigorTestDate);
  const approvedLocation = app.stage === "approved" ? app.recheck?.targetLocation ?? app.targetLocation : null;

  return (
    <article className={`queue-card ${highlighted ? "highlight" : ""} stage-${app.stage}`}>
      <div className="card-head">
        <div>
          <h3>{app.id} · {app.batchNo}</h3>
          <p className="card-sub">{app.crop}　来源：{app.source}　封条：<b>{app.sealNo}</b></p>
        </div>
        <span className={`badge ${meta.tone}`}>{meta.label}</span>
      </div>

      <div className="measure-grid">
        <div>
          <small>发芽率</small>
          <b>{app.germination}%</b>
        </div>
        <div>
          <small>含水率</small>
          <b className={app.moisture > MOISTURE_LIMIT ? "bad-text" : ""}>{app.moisture}%</b>
        </div>
        <div>
          <small>活力检测</small>
          <b className={age > VIGOR_LIMIT_DAYS ? "bad-text" : ""}>{app.vigorTestDate}（{age}天）</b>
        </div>
        <div>
          <small>目标库位</small>
          <b>{app.targetLocation}</b>
        </div>
      </div>

      {app.recheckReasons.length > 0 && app.stage !== "approved" && app.stage !== "superseded" && (
        <div className="reason-box">
          <b>命中复检红线，不能直接批准：</b>
          <ul>{app.recheckReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {app.stage === "superseded" && (
        <div className="reason-box dead">
          <b>本单已失效：</b>{app.supersedeReason}
          {app.orderNo && <p>原调拨单 {app.orderNo} 已作废，封条与库位占用已释放。</p>}
        </div>
      )}

      {app.stage === "approved" && (
        <div className="order-box">
          <b>调拨单 {app.orderNo}</b>
          <span>
            于 {fmt(app.approvedAt!)} 批准；封条 {app.sealNo} 与库位 {approvedLocation} 同时占用。
          </span>
          {app.recheck && (
            <small>
              经复检合格：检测人 {app.recheck.inspector}，复测含水率 {app.recheck.moisture}%、发芽率{" "}
              {app.recheck.germination}%。
            </small>
          )}
        </div>
      )}

      {app.stage === "rejected" && app.recheck && (
        <div className="reason-box dead">
          <b>处置结论：{DISPOSAL_LABEL[app.recheck.conclusion]}</b>
          <p>
            检测人 {app.recheck.inspector}；复测含水率 {app.recheck.moisture}%、发芽率{" "}
            {app.recheck.germination}%；未占用封条与库位。{app.recheck.note ? `备注：${app.recheck.note}` : ""}
          </p>
        </div>
      )}

      {app.duplicateCount > 0 && (
        <p className="dup-line">该封条另有 {app.duplicateCount} 次重复申请，均沿用本单首次检测结果。</p>
      )}

      {(app.stage === "registered" || app.stage === "rechecking") && (
        <div className="card-actions">
          {app.stage === "registered" && (
            <button className="primary" onClick={onApprove}>
              复核通过 · 占用封条/库位
            </button>
          )}
          {app.stage === "rechecking" && !showRecheck && (
            <button className="primary" onClick={() => setShowRecheck(true)}>
              录入复检结果
            </button>
          )}
          {app.stage === "registered" && (
            <button onClick={() => { setShowRecheck(true); }}>
              转人工复检
            </button>
          )}
          <button onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "收起历史" : "查看历史"}
          </button>
        </div>
      )}
      {app.stage !== "registered" && app.stage !== "rechecking" && (
        <div className="card-actions">
          <button onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "收起历史" : `查看历史（${app.history.length}）`}
          </button>
        </div>
      )}

      {showRecheck && (app.stage === "registered" || app.stage === "rechecking") && (
        <RecheckForm
          app={app}
          occupiedLocations={occupiedLocations}
          occupiedByOrders={occupiedByOrders}
          onCancel={() => setShowRecheck(false)}
          onSubmit={(rec) => {
            const ok = onSubmitRecheck(rec);
            if (ok) setShowRecheck(false);
            return ok;
          }}
        />
      )}

      {showHistory && (
        <div className="history-box">
          {app.history.map((h, i) => (
            <div key={i} className="history-item">
              <time>{fmt(h.at)}</time>
              <p>{h.text}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/* ===================== 复检表单 ===================== */

function RecheckForm({
  app,
  occupiedLocations,
  occupiedByOrders,
  onCancel,
  onSubmit,
}: {
  app: Application;
  occupiedLocations: Set<string>;
  occupiedByOrders: Map<string, string>;
  onCancel: () => void;
  onSubmit: (rec: Omit<RecheckRecord, "at">) => boolean;
}) {
  const [inspector, setInspector] = useState("");
  const [moisture, setMoisture] = useState("");
  const [germination, setGermination] = useState("");
  const [conclusion, setConclusion] = useState<Disposal>("qualified");
  const [targetLocation, setTargetLocation] = useState(app.targetLocation);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const m = parseFloat(moisture);
  const g = parseFloat(germination);

  function submit() {
    if (!inspector.trim()) return setError("请填写检测人。");
    if (Number.isNaN(m) || Number.isNaN(g)) return setError("请填写复测含水率与复测发芽率。");
    if (m < 0 || m > 100 || g < 0 || g > 100) return setError("复测值需在 0–100 之间。");

    if (conclusion === "qualified") {
      if (m > MOISTURE_LIMIT) {
        setError(`复测含水率 ${m}% 仍高于 ${MOISTURE_LIMIT}%，不能判定合格，请改选处置结论。`);
        return;
      }
      const holder = occupiedByOrders.get(targetLocation);
      if (occupiedLocations.has(targetLocation) && holder !== app.id) {
        setError(`库位 ${targetLocation} 已占用，请先调整到空闲库位再通过。`);
        return;
      }
    }

    return void onSubmit({
      inspector: inspector.trim(),
      moisture: m,
      germination: g,
      conclusion,
      targetLocation,
      note: note.trim() || undefined,
    });
  }

  return (
    <div className="recheck-form">
      <h4>复检记录</h4>
      <div className="field-grid">
        <label>
          <span>检测人 *</span>
          <input value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="检测员姓名 / 工号" />
        </label>
        <label>
          <span>复测含水率（%）*</span>
          <input type="number" step={0.1} value={moisture} onChange={(e) => setMoisture(e.target.value)} placeholder={`须 ≤ ${MOISTURE_LIMIT}% 方可合格`} />
        </label>
        <label>
          <span>复测发芽率（%）*</span>
          <input type="number" step={0.1} value={germination} onChange={(e) => setGermination(e.target.value)} placeholder="如 94" />
        </label>
        <label>
          <span>处置结论 *</span>
          <select value={conclusion} onChange={(e) => setConclusion(e.target.value as Disposal)}>
            <option value="qualified">合格通过（占用封条与库位、生成调拨单）</option>
            <option value="drying">干燥处理后重检（不占用、退回）</option>
            <option value="downgrade">降级使用（不占用、退回）</option>
            <option value="scrap">报废销毁（不占用、退回）</option>
          </select>
        </label>
        <label>
          <span>复检确认库位{conclusion === "qualified" ? " *" : ""}</span>
          <select value={targetLocation} onChange={(e) => setTargetLocation(e.target.value)}>
            {LOCATIONS.map((l) => {
              const holder = occupiedByOrders.get(l.code);
              const blocked = occupiedLocations.has(l.code) && holder !== app.id;
              return (
                <option key={l.code} value={l.code} disabled={conclusion === "qualified" && blocked}>
                  {l.code}（{blocked ? "已占用，不可选" : "可用"}）
                </option>
              );
            })}
          </select>
        </label>
        <label>
          <span>处置说明</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：干燥 48h 后重检" />
        </label>
      </div>
      {conclusion === "qualified" && !Number.isNaN(m) && m <= MOISTURE_LIMIT && (
        <p className="recheck-hint ok-text">
          通过后将同时占用封条 {app.sealNo} 与库位 {targetLocation}，并生成调拨单。
        </p>
      )}
      {conclusion !== "qualified" && (
        <p className="recheck-hint bad-text">非合格结论不会占用封条与库位，工单按处置结论退回。</p>
      )}
      {error && <p className="recheck-error">{error}</p>}
      <div className="card-actions">
        <button className="primary" onClick={submit}>
          提交复检
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

export default App;
