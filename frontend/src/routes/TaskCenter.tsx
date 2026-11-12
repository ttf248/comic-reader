import PageHeading from "../components/common/PageHeading";
import { useTaskCenter } from "../hooks/useTaskCenter";
import { useSectionSpy } from "../hooks/useSectionSpy";
import { TASK_SECTIONS } from "../utils/pageSections";
import TaskConsole from "../components/tasks/TaskConsole";
import TaskQueuePanel from "../components/tasks/TaskQueuePanel";
import ComputeHardwarePanel from "../components/tasks/ComputeHardwarePanel";
import DailyPlanPanel from "../components/tasks/DailyPlanPanel";
import JobHistoryPanel from "../components/tasks/JobHistoryPanel";
import StorageSection from "../components/tasks/StorageSection";
import { Link } from "react-router-dom";

/**
 * 任务中心：四个编号区块顺次往下排。
 *
 * 之前五段等权重地纵向排下来，页面四千多像素高，空队列和空记录各占一整
 * 块版面，用户要滚到第三屏才看到自己的磁盘占用。现在合成四段，页面顶上
 * 挂一条分区条 —— 竖轴归左侧栏，横轴归这一页，两条轴各管一程。
 */
export default function TaskCenter() {
  const center = useTaskCenter();
  const { snapshot, active, queue, history, plan } = center;
  const taskActionsBusy = center.busy || center.gpuSaving;
  // 分区由侧栏显示，这里只负责把当前分区记进 store。
  useSectionSpy(TASK_SECTIONS, "/tasks");

  return (
    <div className="pb-12">
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
        <section id="run" className="scroll-mt-14">
          <div className="section-heading">
            <span className="section-index">01</span>
            <h2 className="section-title">运行</h2>
            <span className="section-meta">
              {active ? "当前任务的进度与控制" : "开始一次分析"}
            </span>
            <span className="section-rule" />
          </div>
          <TaskConsole
            active={active}
            lastJob={history[0]}
            loading={center.loading}
            busy={taskActionsBusy}
            modules={snapshot?.modules ?? []}
            peopleEnabled={plan.peopleEnabled}
            queuedCount={queue.length}
            embeddingStatus={center.embeddingStatus}
            embeddingStatusLoading={center.embeddingStatusLoading}
            selection={center.selection}
            estimate={center.estimate}
            estimateLoading={center.estimateLoading}
            estimateError={center.estimateError}
            onStart={center.start}
            onStartAll={center.startAll}
            onAction={center.act}
            onRefreshEstimate={center.refreshEstimate}
          />
          <div className="mt-4">
            <TaskQueuePanel
              jobs={queue}
              busy={center.busy}
              loading={center.loading}
              onMove={center.moveQueued}
              onCancel={(id) => center.act(id, "cancel")}
              onClear={center.clearQueue}
            />
          </div>
          <ComputeHardwarePanel
            gpuEnabled={center.gpuEnabled}
            disabled={center.loading}
            saving={center.gpuSaving}
            saveError={center.gpuSaveError}
            status={center.embeddingStatus}
            statusLoading={center.embeddingStatusLoading}
            onChange={center.setGPUEnabled}
          />
          {center.sequenceSkipped && center.sequenceSkipped.length > 0 ? (
            <p role="status" className="mt-3 text-meta text-warning">
              本次按序启动已跳过未就绪模块：
              {center.sequenceSkipped.map((module) => module.name).join("、")}。
              可在下方「本机存储」查看模型与运行环境。
            </p>
          ) : null}
          {center.operationError ? (
            <p role="alert" className="mt-3 text-meta text-danger">
              操作未完成，请稍后重试。
            </p>
          ) : null}
        </section>

        <section id="history" className="scroll-mt-14">
          <div className="section-heading">
            <span className="section-index">02</span>
            <h2 className="section-title">任务记录</h2>
            <span className="section-meta">{history.length} 项</span>
            <span className="section-rule" />
          </div>
          <JobHistoryPanel
            jobs={history}
            retryDisabled={Boolean(active) || taskActionsBusy}
            busy={taskActionsBusy}
            onRetry={(id) => center.act(id, "retry")}
            onDelete={center.deleteHistoryItem}
            onClear={center.clearHistory}
          />
        </section>

        <section id="plan" className="scroll-mt-14">
          <div className="section-heading">
            <span className="section-index">03</span>
            <h2 className="section-title">每日计划</h2>
            <span className="section-meta">按设备本地时间自动检查</span>
            <span className="section-rule" />
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
            estimate={center.estimate}
            estimateLoading={center.estimateLoading}
            estimateError={center.estimateError}
          />
        </section>

        <section id="storage" className="scroll-mt-14">
          <div className="section-heading">
            <span className="section-index">04</span>
            <h2 className="section-title">本机存储</h2>
            <span className="section-meta">派生缓存、模型与产物</span>
            <span className="section-rule" />
          </div>
          <StorageSection />
        </section>
      </div>
    </div>
  );
}
