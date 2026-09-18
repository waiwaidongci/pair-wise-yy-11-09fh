import { useEffect, useMemo, useState } from "react";
import "./styles.css";

/* ----------------------------- 类型与常量 ----------------------------- */

type GateKey = "moisture" | "vigor" | "occupied";
type Status = "review" | "recheck" | "approved" | "reused" | "void";
type Conclusion = "pass" | "dry" | "rescreen" | "scrap";

interface Gate {
  key: GateKey;
  text: string;
}

interface RecheckRecord {
  inspector: string;
  germination: number | null;
  moisture: number | null;
  conclusion: Conclusion;
  note: string;
  testedAt: string;
}

interface AppRecord {
  id: string;
  batchNo: string;
  sourceLocation: string;
  sealNo: string;
  targetLocation: string;
  germination: number | null;
  moisture: number | null;
  vigorTestDate: string;
  applicant: string;
  createdAt: string;
  status: Status;
  gates: Gate[];
  isReuse: boolean;
  reuseOfId?: string;
  recheck?: RecheckRecord;
  recheckHistory?: RecheckRecord[];
  orderNo?: string;
  approvedAt?: string;
  voidedAt?: string;
  voidReason?: string;
}

interface Store {
  apps: AppRecord[];
  seq: number;
}

const STORAGE_KEY = "germplasm-transfer-review-v1";
const MOISTURE_LIMIT = 13;
const VIGOR_LIMIT_DAYS = 90;

// 复核台已知目标库位（实际项目中应来自库位主数据）
const KNOWN_LOCATIONS = [
  "B-01-02",
  "B-02-05",
  "B-03-08",
  "B-04-01",
  "C-01-06",
  "C-03-09",
];

const CONCLUSIONS: { value: Conclusion; label: string; pass: boolean }[] = [
  { value: "pass", label: "复检合格 · 放行入库", pass: true },
  { value: "dry", label: "退回干燥处理", pass: false },
  { value: "rescreen", label: "重新清选后送检", pass: false },
  { value: "scrap", label: "活力丧失 · 申请报废", pass: false },
];

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  review: { label: "待复核", cls: "st-review" },
  recheck: { label: "待复检", cls: "st-recheck" },
  approved: { label: "已批调拨", cls: "st-approved" },
  reused: { label: "沿用首次", cls: "st-reused" },
  void: { label: "已失效", cls: "st-void" },
};

type TabKey = "todo" | "review" | "recheck" | "orders" | "all";

const TABS: { key: TabKey; label: string }[] = [
  { key: "todo", label: "待办工作台" },
  { key: "review", label: "待复核" },
  { key: "recheck", label: "待复检" },
  { key: "orders", label: "调拨单" },
  { key: "all", label: "全部历史" },
];

/* ------------------------------- 工具函数 ------------------------------ */

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowStr(): string {
  const d = new Date();
  return `${todayStr()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function compactDate(s: string): string {
  return s.replace(/-/g, "");
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

function numOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------- 示例数据 ------------------------------ */

function seedStore(): Store {
  return {
    seq: 4,
    apps: [
      {
        id: "APP-20260915-001",
        batchNo: "ZP-26031",
        sourceLocation: "A-01-03",
        sealNo: "SN-A021",
        targetLocation: "B-02-05",
        germination: 92,
        moisture: 11.8,
        vigorTestDate: "2026-08-20",
        applicant: "周敏",
        createdAt: "2026-09-15 09:12",
        status: "approved",
        gates: [],
        isReuse: false,
        orderNo: "DB-20260915-001",
        approvedAt: "2026-09-15 09:26",
      },
      {
        id: "APP-20260916-002",
        batchNo: "ZP-26044",
        sourceLocation: "A-03-11",
        sealNo: "SN-A037",
        targetLocation: "B-01-02",
        germination: 88,
        moisture: 13.6,
        vigorTestDate: "2026-08-28",
        applicant: "李振东",
        createdAt: "2026-09-16 14:02",
        status: "recheck",
        gates: [
          {
            key: "moisture",
            text: `含水率 13.6% 高于 ${MOISTURE_LIMIT}%，只能转入复检`,
          },
        ],
        isReuse: false,
      },
      {
        id: "APP-20260917-003",
        batchNo: "ZP-25180",
        sourceLocation: "C-02-07",
        sealNo: "SN-B108",
        targetLocation: "B-02-05",
        germination: 90,
        moisture: 12.4,
        vigorTestDate: "2026-05-20",
        applicant: "王雪",
        createdAt: "2026-09-17 10:40",
        status: "recheck",
        gates: [
          {
            key: "vigor",
            text: `活力检测距今 ${daysBetween(
              "2026-05-20",
              "2026-09-17"
            )} 天，超过 ${VIGOR_LIMIT_DAYS} 天`,
          },
          {
            key: "occupied",
            text: "目标库位 B-02-05 已被 DB-20260915-001 占用",
          },
        ],
        isReuse: false,
      },
      {
        id: "APP-20260918-004",
        batchNo: "ZP-26052",
        sourceLocation: "A-02-09",
        sealNo: "SN-A044",
        targetLocation: "B-03-08",
        germination: 95,
        moisture: 11.2,
        vigorTestDate: "2026-09-01",
        applicant: "周敏",
        createdAt: "2026-09-18 08:30",
        status: "review",
        gates: [],
        isReuse: false,
      },
    ],
  };
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (Array.isArray(parsed.apps)) return parsed;
    }
  } catch {
    // 存档损坏时回落到示例数据
  }
  return seedStore();
}

/* -------------------------------- 主组件 ------------------------------- */

interface FormState {
  batchNo: string;
  sourceLocation: string;
  sealNo: string;
  targetLocation: string;
  germination: string;
  moisture: string;
  vigorTestDate: string;
  applicant: string;
}

const emptyForm: FormState = {
  batchNo: "",
  sourceLocation: "",
  sealNo: "",
  targetLocation: "",
  germination: "",
  moisture: "",
  vigorTestDate: todayStr(),
  applicant: "",
};

interface RecheckDraft {
  inspector: string;
  germination: string;
  moisture: string;
  conclusion: Conclusion;
  note: string;
}

function App() {
  const [store, setStore] = useState<Store>(loadStore);
  const [tab, setTab] = useState<TabKey>("todo");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RecheckDraft>>({});
  const [toast, setToast] = useState<string>("");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [store]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const apps = store.apps;

  /* ---------- 派生数据：生效批准、封条/库位占用、首次申请索引 ---------- */

  const active = useMemo(
    () => apps.filter((a) => a.status === "approved"),
    [apps]
  );

  const occupiedLocation = useMemo(() => {
    const m = new Map<string, AppRecord>();
    active.forEach((a) => m.set(a.targetLocation, a));
    return m;
  }, [active]);

  const firstBySeal = useMemo(() => {
    const m = new Map<string, AppRecord>();
    [...apps]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .forEach((a) => {
        if (!m.has(a.sealNo)) m.set(a.sealNo, a);
      });
    return m;
  }, [apps]);

  /* ---------------------------- 登记表单实时校验 ---------------------------- */

  const fBatch = form.batchNo.trim();
  const fSeal = form.sealNo.trim();
  const fTarget = form.targetLocation.trim();
  const fMoisture = numOrNull(form.moisture);
  const fGermination = numOrNull(form.germination);
  const fVigorDays = form.vigorTestDate
    ? daysBetween(form.vigorTestDate, todayStr())
    : null;

  const sealedBefore = fSeal ? firstBySeal.get(fSeal) : undefined;

  // 同批次旧批准在新检测登记时立即失效，其库位随之释放，故占用判定排除同批次
  const targetHolder =
    fTarget && occupiedLocation.get(fTarget)?.batchNo !== fBatch
      ? occupiedLocation.get(fTarget)
      : undefined;

  const liveGates: Gate[] = [];
  if (fMoisture !== null && fMoisture > MOISTURE_LIMIT) {
    liveGates.push({
      key: "moisture",
      text: `含水率 ${fMoisture}% 高于 ${MOISTURE_LIMIT}%`,
    });
  }
  if (fVigorDays !== null && fVigorDays > VIGOR_LIMIT_DAYS) {
    liveGates.push({
      key: "vigor",
      text: `活力检测距今 ${fVigorDays} 天，超过 ${VIGOR_LIMIT_DAYS} 天`,
    });
  }
  if (targetHolder) {
    liveGates.push({
      key: "occupied",
      text: `目标库位 ${fTarget} 已被 ${targetHolder.orderNo}（批次 ${targetHolder.batchNo}）占用`,
    });
  }

  /* -------------------------------- 操作 -------------------------------- */

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function register() {
    const errs: string[] = [];
    if (!fBatch) errs.push("请填写批次编号");
    if (!form.sourceLocation.trim()) errs.push("请填写来源库位");
    if (!fSeal) errs.push("请填写封条编号");
    if (!fTarget || !KNOWN_LOCATIONS.includes(fTarget))
      errs.push("请选择有效的目标库位");
    if (fGermination === null || fGermination < 0 || fGermination > 100)
      errs.push("发芽率需为 0–100 的数值");
    if (fMoisture === null || fMoisture < 0 || fMoisture > 30)
      errs.push("含水率需为 0–30 的数值");
    if (!form.vigorTestDate) errs.push("请选择活力检测日期");
    if (!form.applicant.trim()) errs.push("请填写申请人");
    setErrors(errs);
    if (errs.length > 0) return;

    const ts = nowStr();
    setStore((prev) => {
      const seq = prev.seq + 1;
      const id = `APP-${compactDate(todayStr())}-${pad(seq, 3)}`;
      let appsNext = [...prev.apps];
      const notices: string[] = [];

      // 同一封条重复申请：沿用首次结果，不独立占用封条/库位、不再走闸门
      const first = [...appsNext]
        .filter((a) => a.sealNo === fSeal)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (first) {
        const reused: AppRecord = {
          id,
          batchNo: fBatch,
          sourceLocation: form.sourceLocation.trim(),
          sealNo: fSeal,
          targetLocation: fTarget,
          germination: fGermination,
          moisture: fMoisture,
          vigorTestDate: form.vigorTestDate,
          applicant: form.applicant.trim(),
          createdAt: ts,
          status: "reused",
          gates: [],
          isReuse: true,
          reuseOfId: first.id,
        };
        appsNext.push(reused);
        notices.push(
          first.status === "approved"
            ? `封条 ${fSeal} 重复申请，已沿用首次批准（${first.orderNo}）`
            : `封条 ${fSeal} 重复申请，已沿用首次申请 ${first.id} 的结果`
        );
        setTimeout(() => setToast(notices.join("；")), 0);
        return { apps: appsNext, seq };
      }

      // 新检测：同批次旧批准立即失效，释放其封条与库位（历史保留）
      const superseded = appsNext.filter(
        (a) => a.status === "approved" && a.batchNo === fBatch
      );
      if (superseded.length > 0) {
        const deadIds = new Set(superseded.map((a) => a.id));
        appsNext = appsNext.map((a) =>
          deadIds.has(a.id)
            ? {
                ...a,
                status: "void" as Status,
                voidedAt: ts,
                voidReason: `批次 ${fBatch} 出现新检测（封条 ${fSeal}，申请 ${id}），原批准立即失效`,
              }
            : a
        );
        notices.push(
          `新检测已登记，原批准 ${superseded
            .map((a) => a.orderNo)
            .join("、")} 立即失效，封条与库位已释放`
        );
      }

      // 失效释放后重新评估三道闸门
      const gatesNow: Gate[] = [];
      if ((fMoisture as number) > MOISTURE_LIMIT) {
        gatesNow.push({
          key: "moisture",
          text: `含水率 ${fMoisture}% 高于 ${MOISTURE_LIMIT}%，只能转入复检`,
        });
      }
      const age = daysBetween(form.vigorTestDate, todayStr());
      if (age > VIGOR_LIMIT_DAYS) {
        gatesNow.push({
          key: "vigor",
          text: `活力检测距今 ${age} 天，超过 ${VIGOR_LIMIT_DAYS} 天，只能转入复检`,
        });
      }
      const holder = appsNext.find(
        (a) => a.status === "approved" && a.targetLocation === fTarget
      );
      if (holder) {
        gatesNow.push({
          key: "occupied",
          text: `目标库位 ${fTarget} 已被 ${holder.orderNo} 占用，只能转入复检`,
        });
      }

      const rec: AppRecord = {
        id,
        batchNo: fBatch,
        sourceLocation: form.sourceLocation.trim(),
        sealNo: fSeal,
        targetLocation: fTarget,
        germination: fGermination,
        moisture: fMoisture,
        vigorTestDate: form.vigorTestDate,
        applicant: form.applicant.trim(),
        createdAt: ts,
        status: gatesNow.length > 0 ? "recheck" : "review",
        gates: gatesNow,
        isReuse: false,
      };
      appsNext.push(rec);
      notices.push(
        gatesNow.length > 0
          ? `登记成功：命中 ${gatesNow.length} 项限制，${id} 已转入复检`
          : `登记成功：${id} 进入复核队列`
      );
      setTimeout(() => setToast(notices.join("；")), 0);
      return { apps: appsNext, seq };
    });
    setForm((f) => ({ ...emptyForm, applicant: f.applicant }));
  }

  function approve(id: string, recheck?: RecheckRecord) {
    const rec = apps.find((a) => a.id === id);
    if (!rec || (rec.status !== "review" && rec.status !== "recheck")) return;

    // 通过前再次确认库位未被其他批次占用（复核期间可能变化）
    const holder = apps.find(
      (a) =>
        a.status === "approved" &&
        a.targetLocation === rec.targetLocation &&
        a.batchNo !== rec.batchNo
    );
    if (holder) {
      setToast(
        `目标库位 ${rec.targetLocation} 现已被 ${holder.orderNo} 占用，只能转入复检`
      );
      setStore((prev) => ({
        ...prev,
        apps: prev.apps.map((a) =>
          a.id === id && a.status === "review"
            ? {
                ...a,
                status: "recheck",
                gates: [
                  ...a.gates,
                  {
                    key: "occupied",
                    text: `复核时确认库位 ${rec.targetLocation} 已被 ${holder.orderNo} 占用`,
                  },
                ],
              }
            : a
        ),
      }));
      return;
    }

    const ts = nowStr();
    setStore((prev) => {
      const seq = prev.seq + 1;
      const orderNo = `DB-${compactDate(todayStr())}-${pad(seq, 3)}`;
      // 防御性：同批次若仍有其他生效批准（正常已在登记时失效），一并作废
      const dead = new Set(
        prev.apps
          .filter(
            (a) =>
              a.status === "approved" &&
              a.batchNo === rec.batchNo &&
              a.id !== id
          )
          .map((a) => a.id)
      );
      const appsNext = prev.apps.map((a) => {
        if (dead.has(a.id)) {
          return {
            ...a,
            status: "void" as Status,
            voidedAt: ts,
            voidReason: `批次 ${rec.batchNo} 新批准 ${orderNo} 生效，原批准自动失效`,
          };
        }
        if (a.id === id) {
          const history = a.recheckHistory
            ? [...a.recheckHistory]
            : a.recheck
            ? [a.recheck]
            : [];
          if (recheck) history.push(recheck);
          return {
            ...a,
            status: "approved" as Status,
            approvedAt: ts,
            orderNo,
            recheck,
            recheckHistory: history.length > 0 ? history : undefined,
          };
        }
        return a;
      });
      setTimeout(
        () =>
          setToast(
            `复核通过：封条 ${rec.sealNo} 与库位 ${rec.targetLocation} 已同时占用，调拨单 ${orderNo} 已生成`
          ),
        0
      );
      return { apps: appsNext, seq };
    });
    setDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  }

  function submitRecheck(id: string) {
    const rec = apps.find((a) => a.id === id);
    const draft = drafts[id];
    if (!rec || !draft) return;
    if (!draft.inspector.trim()) return setToast("请填写检测人");
    const m = numOrNull(draft.moisture);
    const g = numOrNull(draft.germination);
    if (m === null || m < 0 || m > 30)
      return setToast("复测含水率需为 0–30 的数值");
    if (draft.germination.trim() !== "" && (g === null || g < 0 || g > 100))
      return setToast("复测发芽率需为 0–100 的数值");

    const rc: RecheckRecord = {
      inspector: draft.inspector.trim(),
      germination: g,
      moisture: m,
      conclusion: draft.conclusion,
      note: draft.note.trim(),
      testedAt: nowStr(),
    };

    if (draft.conclusion === "pass") {
      if (m > MOISTURE_LIMIT) {
        setToast(
          `复测含水率 ${m}% 仍高于 ${MOISTURE_LIMIT}%，不能放行：请干燥后重测，或选择处置结论`
        );
        return;
      }
      approve(id, rc);
      return;
    }

    setStore((prev) => ({
      ...prev,
      apps: prev.apps.map((a) => {
        if (a.id !== id) return a;
        const history = a.recheckHistory
          ? [...a.recheckHistory]
          : a.recheck
          ? [a.recheck]
          : [];
        history.push(rc);
        return { ...a, recheck: rc, recheckHistory: history };
      }),
    }));
    setToast(
      `复检结论已记录：${
        CONCLUSIONS.find((c) => c.value === draft.conclusion)?.label
      }，未占用封条与库位`
    );
  }

  function resetDemo() {
    const seeded = seedStore();
    setStore(seeded);
    setDrafts({});
    setToast("已恢复示例数据");
  }

  function exportCsv() {
    const header = [
      "申请单号",
      "批次",
      "来源库位",
      "封条编号",
      "目标库位",
      "发芽率%",
      "含水率%",
      "活力检测日期",
      "申请人",
      "登记时间",
      "状态",
      "调拨单号",
      "复检检测人",
      "复测含水率",
      "复测发芽率",
      "处置结论",
      "复检次数",
      "失效原因",
    ];
    const rows = [...apps]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => [
        a.id,
        a.batchNo,
        a.sourceLocation,
        a.sealNo,
        a.targetLocation,
        a.germination ?? "",
        a.moisture ?? "",
        a.vigorTestDate,
        a.applicant,
        a.createdAt,
        STATUS_META[a.status].label,
        a.orderNo ?? "",
        a.recheck?.inspector ?? "",
        a.recheck?.moisture ?? "",
        a.recheck?.germination ?? "",
        a.recheck
          ? CONCLUSIONS.find((c) => c.value === a.recheck!.conclusion)?.label
          : "",
        a.recheckHistory?.length ? `${a.recheckHistory.length} 次复检` : "",
        a.voidReason ?? "",
      ]);
    const csv = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["﻿" + csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `种质库调拨复核_${todayStr()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /* -------------------------------- 过滤 -------------------------------- */

  const visible = useMemo(() => {
    const sorted = [...apps].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    switch (tab) {
      case "review":
        return sorted.filter((a) => a.status === "review");
      case "recheck":
        return sorted.filter((a) => a.status === "recheck");
      case "orders":
        return sorted.filter(
          (a) => a.status === "approved" || (a.status === "void" && a.orderNo)
        );
      case "all":
        return sorted;
      default:
        return sorted.filter(
          (a) => a.status === "review" || a.status === "recheck"
        );
    }
  }, [apps, tab]);

  const counts: Record<TabKey, number> = {
    todo: apps.filter((a) => a.status === "review" || a.status === "recheck")
      .length,
    review: apps.filter((a) => a.status === "review").length,
    recheck: apps.filter((a) => a.status === "recheck").length,
    orders: active.length,
    all: apps.length,
  };

  /* -------------------------------- 渲染 -------------------------------- */

  return (
    <main className="app">
      {toast && <div className="toast">{toast}</div>}

      <section className="hero">
        <p>GB-GENEBANK · 跨库业务 · Port 62010</p>
        <h1>种质库跨库调拨复核台</h1>
        <span>
          登记发芽率、含水率、封条编号与目标库位；含水率高于 {MOISTURE_LIMIT}%、活力检测超过{" "}
          {VIGOR_LIMIT_DAYS} 天或目标库位已占用时只能转入复检。同一封条重复申请沿用首次结果；复检通过后同时占用封条与库位并生成调拨单，批次出现新检测时旧批准立即失效。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>待复核</small>
          <strong>{counts.review}</strong>
        </article>
        <article>
          <small>待复检</small>
          <strong>{counts.recheck}</strong>
        </article>
        <article>
          <small>生效调拨单</small>
          <strong>{active.length}</strong>
        </article>
        <article>
          <small>占用库位</small>
          <strong>{occupiedLocation.size}</strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>业务视图</h2>
          <div className="chips vertical">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={tab === t.key ? "chip-active" : ""}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <em>{counts[t.key]}</em>
              </button>
            ))}
          </div>

          <h2 className="loc-title">目标库位占用</h2>
          <div className="loc-grid">
            {KNOWN_LOCATIONS.map((loc) => {
              const holder = occupiedLocation.get(loc);
              return (
                <div
                  key={loc}
                  className={`loc ${holder ? "loc-busy" : "loc-free"}`}
                  title={holder ? `${holder.orderNo} · ${holder.batchNo}` : "空闲"}
                >
                  <b>{loc}</b>
                  <span>{holder ? `占用·${holder.batchNo}` : "空闲"}</span>
                </div>
              );
            })}
          </div>
          <p className="loc-hint">占用判定实时联动，登记与复核时均会重新校验。</p>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>跨库调拨申请</p>
              <h2>登记检测信息</h2>
            </div>
            <button className="primary" onClick={register}>
              {sealedBefore
                ? "重复申请 · 沿用首次结果"
                : liveGates.length > 0
                ? "登记并转入复检"
                : "提交登记 / 复核"}
            </button>
          </div>

          {sealedBefore && (
            <div className="banner warn">
              封条 <b>{fSeal}</b> 曾在{" "}
              <b>{sealedBefore.createdAt}</b> 申请过（{sealedBefore.id}
              ）。提交后将沿用首次结果：
              {sealedBefore.status === "approved"
                ? `首次已批准，调拨单 ${sealedBefore.orderNo}`
                : sealedBefore.status === "void"
                ? "首次批准已被新检测失效"
                : `首次状态为「${STATUS_META[sealedBefore.status].label}」`}
              ，本次不独立占用封条与库位。
            </div>
          )}

          {errors.length > 0 && (
            <div className="banner error">
              {errors.map((e) => (
                <span key={e}>· {e}</span>
              ))}
            </div>
          )}

          <div className="field-grid">
            <label>
              <span>批次编号</span>
              <input
                placeholder="如 ZP-26031"
                value={form.batchNo}
                onChange={(e) => update("batchNo", e.target.value)}
              />
            </label>
            <label>
              <span>来源库位</span>
              <input
                placeholder="如 A-01-03"
                value={form.sourceLocation}
                onChange={(e) => update("sourceLocation", e.target.value)}
              />
            </label>
            <label>
              <span>封条编号</span>
              <input
                placeholder="如 SN-A021"
                value={form.sealNo}
                onChange={(e) => update("sealNo", e.target.value)}
              />
            </label>
            <label>
              <span>目标库位</span>
              <select
                value={form.targetLocation}
                onChange={(e) => update("targetLocation", e.target.value)}
              >
                <option value="">请选择目标库位</option>
                {KNOWN_LOCATIONS.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                    {occupiedLocation.get(loc) ? "（已占用）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>发芽率（%）</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                placeholder="0–100"
                value={form.germination}
                onChange={(e) => update("germination", e.target.value)}
              />
            </label>
            <label>
              <span>含水率（%，阈值 {MOISTURE_LIMIT}%）</span>
              <input
                type="number"
                min={0}
                max={30}
                step={0.1}
                placeholder="0–30"
                value={form.moisture}
                onChange={(e) => update("moisture", e.target.value)}
              />
            </label>
            <label>
              <span>活力检测日期（{VIGOR_LIMIT_DAYS} 天内有效）</span>
              <input
                type="date"
                value={form.vigorTestDate}
                max={todayStr()}
                onChange={(e) => update("vigorTestDate", e.target.value)}
              />
            </label>
            <label>
              <span>申请人</span>
              <input
                placeholder="登记人姓名"
                value={form.applicant}
                onChange={(e) => update("applicant", e.target.value)}
              />
            </label>
          </div>

          <div className="gate-row">
            <GatePill
              hit={fMoisture !== null && fMoisture > MOISTURE_LIMIT}
              label={
                fMoisture === null
                  ? "含水率待填"
                  : `含水率 ${fMoisture}%${
                      fMoisture > MOISTURE_LIMIT ? " 超限" : " 合格"
                    }`
              }
            />
            <GatePill
              hit={fVigorDays !== null && fVigorDays > VIGOR_LIMIT_DAYS}
              label={
                fVigorDays === null
                  ? "活力日期待填"
                  : `活力检测 ${fVigorDays} 天${
                      fVigorDays > VIGOR_LIMIT_DAYS ? " 超期" : " 有效"
                    }`
              }
            />
            <GatePill
              hit={Boolean(targetHolder)}
              label={
                !fTarget
                  ? "目标库位待选"
                  : targetHolder
                  ? `${fTarget} 已占用`
                  : `${fTarget} 空闲`
              }
            />
            {liveGates.length > 0 && !sealedBefore && (
              <span className="gate-result">命中限制 → 只能转入复检</span>
            )}
            {sealedBefore && (
              <span className="gate-result neutral">重复封条 → 沿用首次结果</span>
            )}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>复核工作台</p>
            <h2>
              {TABS.find((t) => t.key === tab)?.label}
              <small className="count-tag">{visible.length}</small>
            </h2>
          </div>
          <div className="btn-row">
            <button onClick={exportCsv}>导出CSV</button>
            <button onClick={resetDemo}>重置示例数据</button>
          </div>
        </div>

        {visible.length === 0 && (
          <div className="empty">当前视图没有记录。</div>
        )}

        <div className="records">
          {visible.map((a) => (
            <RecordCard
              key={a.id}
              rec={a}
              referenced={
                a.isReuse && a.reuseOfId
                  ? apps.find((x) => x.id === a.reuseOfId)
                  : undefined
              }
              draft={drafts[a.id]}
              setDraft={(d) =>
                setDrafts((prev) => ({ ...prev, [a.id]: d }))
              }
              onApprove={() => approve(a.id)}
              onSubmitRecheck={() => submitRecheck(a.id)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

/* ------------------------------ 展示子组件 ----------------------------- */

function GatePill({ hit, label }: { hit: boolean; label: string }) {
  return <span className={`pill ${hit ? "pill-hit" : "pill-ok"}`}>{label}</span>;
}

interface CardProps {
  rec: AppRecord;
  referenced?: AppRecord;
  draft?: RecheckDraft;
  setDraft: (d: RecheckDraft) => void;
  onApprove: () => void;
  onSubmitRecheck: () => void;
}

function RecordCard({
  rec,
  referenced,
  draft,
  setDraft,
  onApprove,
  onSubmitRecheck,
}: CardProps) {
  const meta = STATUS_META[rec.status];
  const effective: RecheckDraft =
    draft ?? {
      inspector: rec.recheck?.inspector ?? "",
      germination:
        rec.recheck?.germination === null ||
        rec.recheck?.germination === undefined
          ? ""
          : String(rec.recheck.germination),
      moisture: rec.recheck?.moisture === undefined ? "" : String(rec.recheck.moisture),
      conclusion: rec.recheck?.conclusion ?? "pass",
      note: rec.recheck?.note ?? "",
    };

  const disposed =
    rec.status === "recheck" &&
    rec.recheck &&
    rec.recheck.conclusion !== "pass";

  return (
    <article className="record">
      <header className="rec-head">
        <div>
          <h3>
            {rec.batchNo}
            <span className="rec-id">{rec.id}</span>
          </h3>
          <p className="route">
            {rec.sourceLocation} <i>→</i> {rec.targetLocation} · 封条 {rec.sealNo}
          </p>
        </div>
        <span className={`badge ${meta.cls}`}>
          {disposed
            ? `已处置 · ${
                CONCLUSIONS.find((c) => c.value === rec.recheck!.conclusion)
                  ?.label
              }`
            : meta.label}
        </span>
      </header>

      <div className="rec-values">
        <span>
          发芽率<b>{rec.germination ?? "—"}%</b>
        </span>
        <span className={rec.moisture !== null && rec.moisture > MOISTURE_LIMIT ? "val-bad" : ""}>
          含水率<b>{rec.moisture ?? "—"}%</b>
        </span>
        <span>
          活力检测<b>{rec.vigorTestDate}</b>
        </span>
        <span>
          申请人<b>{rec.applicant}</b>
        </span>
        <span>
          登记时间<b>{rec.createdAt}</b>
        </span>
      </div>

      {rec.gates.length > 0 && (
        <ul className="gate-list">
          {rec.gates.map((g) => (
            <li key={g.key}>{g.text}</li>
          ))}
        </ul>
      )}

      {rec.status === "reused" && referenced && (
        <div className="banner neutral">
          同一封条重复申请，沿用首次申请 <b>{referenced.id}</b> 的结果：
          {referenced.status === "approved"
            ? ` 已批调拨单 ${referenced.orderNo}`
            : referenced.status === "void"
            ? ` 首次批准已于 ${referenced.voidedAt} 失效（${referenced.voidReason}）`
            : ` 当前「${STATUS_META[referenced.status].label}」`}
          。本记录不独立占用封条与库位。
        </div>
      )}

      {rec.status === "void" && (
        <div className="banner error">
          已失效：{rec.voidReason}（{rec.voidedAt}）。原占用封条与库位已释放，记录保留备查。
        </div>
      )}

      {rec.status === "approved" && (
        <div className="banner ok">
          复核通过 · 调拨单 <b>{rec.orderNo}</b>（{rec.approvedAt}）：封条{" "}
          {rec.sealNo} 与库位 {rec.targetLocation} 已同时占用。
          {rec.recheck &&
            ` 经复检放行：检测人 ${rec.recheck.inspector}，复测含水率 ${rec.recheck.moisture}%。`}
        </div>
      )}

      {rec.status === "approved" &&
        rec.recheckHistory &&
        rec.recheckHistory.length > 0 && (
          <div className="recheck-log compact">
            <p>复检记录（{rec.recheckHistory.length} 次）</p>
            <ul>
              {rec.recheckHistory.map((h, i) => (
                <li key={`${h.testedAt}-${i}`}>
                  <b>{h.testedAt}</b> · {h.inspector} · 复测含水率{" "}
                  {h.moisture}%
                  {h.germination !== null ? ` · 发芽率 ${h.germination}%` : ""}{" "}
                  · {CONCLUSIONS.find((c) => c.value === h.conclusion)?.label}
                  {h.note ? `（${h.note}）` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

      {(rec.status === "review" || rec.status === "recheck") && (
        <div className="rec-actions">
          {rec.status === "review" ? (
            <button className="primary" onClick={onApprove}>
              复核通过 → 占用封条/库位并生成调拨单
            </button>
          ) : (
            <div className="recheck-box">
              <h4>复检登记</h4>
              <p className="recheck-tip">
                记录检测人、复测值与处置结论；结论为「复检合格」且含水率达标时方可放行占用。
              </p>
              <div className="recheck-grid">
                <label>
                  <span>检测人</span>
                  <input
                    placeholder="复检员姓名"
                    value={effective.inspector}
                    onChange={(e) =>
                      setDraft({ ...effective, inspector: e.target.value })
                    }
                  />
                </label>
                <label>
                  <span>复测发芽率（%）</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={effective.germination}
                    onChange={(e) =>
                      setDraft({ ...effective, germination: e.target.value })
                    }
                  />
                </label>
                <label>
                  <span>复测含水率（%）</span>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    step={0.1}
                    value={effective.moisture}
                    onChange={(e) =>
                      setDraft({ ...effective, moisture: e.target.value })
                    }
                  />
                </label>
                <label>
                  <span>处置结论</span>
                  <select
                    value={effective.conclusion}
                    onChange={(e) =>
                      setDraft({
                        ...effective,
                        conclusion: e.target.value as Conclusion,
                      })
                    }
                  >
                    {CONCLUSIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  <span>备注</span>
                  <input
                    placeholder="如：烘干 4h 后复测 / 芽苗异常说明"
                    value={effective.note}
                    onChange={(e) =>
                      setDraft({ ...effective, note: e.target.value })
                    }
                  />
                </label>
              </div>
              {rec.recheckHistory && rec.recheckHistory.length > 0 && (
                <div className="recheck-log">
                  <p>复检记录（{rec.recheckHistory.length} 次）</p>
                  <ul>
                    {rec.recheckHistory.map((h, i) => (
                      <li key={`${h.testedAt}-${i}`}>
                        <b>{h.testedAt}</b> · {h.inspector} · 复测含水率{" "}
                        {h.moisture}%
                        {h.germination !== null
                          ? ` · 发芽率 ${h.germination}%`
                          : ""}{" "}
                        ·{" "}
                        {
                          CONCLUSIONS.find((c) => c.value === h.conclusion)
                            ?.label
                        }
                        {h.note ? `（${h.note}）` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button className="primary" onClick={onSubmitRecheck}>
                提交复检结论
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default App;
