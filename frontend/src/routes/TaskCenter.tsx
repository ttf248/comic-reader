import PageHeading from "../components/common/PageHeading";
import { useTaskCenter } from "../hooks/useTaskCenter";
import TaskConsole from "../components/tasks/TaskConsole";
import TaskQueuePanel from "../components/tasks/TaskQueuePanel";
import DailyPlanPanel from "../components/tasks/DailyPlanPanel";
import JobHistoryPanel from "../components/tasks/JobHistoryPanel";
import StorageSection from "../components/tasks/StorageSection";
import { Link } from "react-router-dom";

export default function TaskCenter() {
  const center = useTaskCenter();
  const { snapshot, active, queue, history, plan } = center;

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="后台分析"
        title="任务中心"
        description="查看本机分析进度，管理等待队列与任务记录，安排每日增量更新。分析完全在本机运行。"
        action={
          <Link className="btn btn-outline" to="/settings">
            服务设置
          </Link>
        }
      />

      {center.loadError ? (
        <div className="page-shell mt-6 rounded-lg border border-border bg-bg-elevated p-5 text-body text-fg-muted">
          任务状态读取失败。请检查后端是否运行，然后刷新页面。
        </div>
      ) : null}

      <div className="page-shell mt-6 space-y-10">
        <section>
          <div className="section-heading">
            <span className="section-index">01</span>
            <h2 className="section-title">状态</h2>
            <span className="section-meta">
              {active ? "当前任务的进度与控制" : "没有进行中的任务"}
            </span>
          </div>
          <TaskConsole
            active={active}
            queueCount={queue.length}
            lastJob={history[0]}
            loading={center.loading}
            busy={center.busy}
            modules={snapshot?.modules ?? []}
            peopleEnabled={plan.peopleEnabled}
            embeddingStatus={center.embeddingStatus}
            embeddingStatusLoading={center.embeddingStatusLoading}
            onStart={center.start}
            onStartAll={center.startAll}
            onAction={center.act}
          />
          {center.sequenceSkipped && center.sequenceSkipped.length > 0 ? (
            <p role="status" className="mt-3 text-meta text-warning">
              本次按序启动已跳过未就绪模块：
              {center.sequenceSkipped.map((module) => module.name).join("、")}。
              可在本页下方「本机存储」查看模型与运行环境。
            </p>
          ) : null}
          {center.operationError ? (
            <p role="alert" className="mt-3 text-meta text-danger">
              操作未完成，请稍后重试。
            </p>
          ) : null}
        </section>

        <section>
          <div className="section-heading">
            <span className="section-index">02</span>
            <h2 className="section-title">等待队列</h2>
            <span className="section-meta">可调整顺序或取消等待任务</span>
          </div>
          <TaskQueuePanel
            jobs={queue}
            busy={center.busy}
            onMove={center.moveQueued}
            onCancel={(id) => center.act(id, "cancel")}
            onClear={center.clearQueue}
          />
        </section>

        <section>
          <div className="section-heading">
            <span className="section-index">03</span>
            <h2 className="section-title">每日计划</h2>
            <span className="section-meta">按设备本地时间自动检查新增图片</span>
          </div>
          <DailyPlanPanel
            enabled={plan.enabled}
            time={plan.time}
            selectedModules={plan.modules}
            peopleEnabled={plan.peopleEnabled}
            ready={plan.ready}
            onEnabledChange={plan.setEnabled}
            onTimeChange={plan.setTime}
            onModulesChange={plan.setModules}
            onPeopleEnabledChange={plan.setPeopleEnabled}
            onSave={plan.save}
            saving={plan.saving}
            saved={plan.saved}
            error={plan.error}
            lastScheduledDate={snapshot?.settings.lastScheduledDate}
            modules={snapshot?.modules ?? []}
          />
        </section>

        <section>
          <div className="section-heading">
            <span className="section-index">04</span>
            <h2 className="section-title">任务记录</h2>
            <span className="section-meta">{history.length} 项</span>
          </div>
          <JobHistoryPanel
            jobs={history}
            retryDisabled={Boolean(active) || center.busy}
            busy={center.busy}
            onRetry={(id) => center.act(id, "retry")}
            onDelete={center.deleteHistoryItem}
            onClear={center.clearHistory}
          />
        </section>

        <section>
          <div className="section-heading">
            <span className="section-index">05</span>
            <h2 className="section-title">本机存储</h2>
            <span className="section-meta">派生缓存、模型权重与分析产物</span>
          </div>
          <StorageSection />
        </section>
      </div>
    </div>
  );
}
