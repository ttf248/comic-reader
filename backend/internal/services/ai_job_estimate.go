package services

import (
	"context"
	"math"
	"sort"
	"time"
)

const (
	// aiTargetCacheTTL 是文件指纹清单的复用时长。目录重新扫描时 revision
	// 变化会让缓存自然失效；这个上限兜住「文件在应用之外被改动」的情况。
	aiTargetCacheTTL = 30 * time.Second
	// aiEstimateSampleLimit 是历史吞吐样本的最大条数。
	aiEstimateSampleLimit = 5
	// aiEstimateMinSampleImages 是可信样本的最少张数：更少的样本里，整理
	// 清单与加载模型的固定开销会被摊到极少张数上，每张耗时被严重高估。
	aiEstimateMinSampleImages = AIBatchSize
)

// AIJobEstimateMode 是某个模块在一种模式下的核算结果。
type AIJobEstimateMode struct {
	// Count 是本次真正要处理的张数。
	Count int `json:"count"`
	// EstimatedDurationMs 是按历史吞吐推出的预计耗时；没有历史记录时为 nil。
	EstimatedDurationMs *int64 `json:"estimatedDurationMs"`
	// SampleCount 与 SampleImages 说明这个耗时参考了几次历史任务、共多少张图。
	SampleCount  int `json:"sampleCount"`
	SampleImages int `json:"sampleImages"`
}

// AIJobEstimateModule 是单个分析模块的核算结果。
type AIJobEstimateModule struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
	// Available 表示现在能不能启动：已就绪且没有被人物开关锁住。
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Version   string `json:"version,omitempty"`
	// Incremental 与 Full 在模块不可用时为 nil。
	Incremental *AIJobEstimateMode `json:"incremental"`
	Full        *AIJobEstimateMode `json:"full"`
}

// AIJobEstimateTotal 是若干个模块的合计。
type AIJobEstimateTotal struct {
	Count int `json:"count"`
	// EstimatedDurationMs 在任一参与模块没有历史时为 nil —— 不能拿有历史
	// 的那部分假装能估出整体。
	EstimatedDurationMs *int64   `json:"estimatedDurationMs"`
	Modules             []string `json:"modules"`
}

// AIJobEstimateSequence 是「按序启动全部任务」在两种模式下的合计。
type AIJobEstimateSequence struct {
	Incremental AIJobEstimateTotal `json:"incremental"`
	Full        AIJobEstimateTotal `json:"full"`
}

// AIJobEstimate 是空闲时的一次核算快照。
type AIJobEstimate struct {
	GeneratedAt     time.Time             `json:"generatedAt"`
	LibraryRevision uint64                `json:"libraryRevision"`
	LibraryReady    bool                  `json:"libraryReady"`
	TotalImages     int                   `json:"totalImages"`
	Modules         []AIJobEstimateModule `json:"modules"`
	Sequence        AIJobEstimateSequence `json:"sequence"`
}

// aiRecordFact 是判断「结果是否仍然有效」需要的最小事实。
//
// 从 s.records 里拷出来，避免在任务状态锁内做 map 查找与索引查询。
type aiRecordFact struct {
	resourceID    string
	moduleType    string
	size          int64
	mtimeNs       int64
	moduleVersion string
	status        string
}

// aiTargetStat 是某个目标的当前文件指纹。
type aiTargetStat struct {
	size    int64
	mtimeNs int64
}

// aiEstimateSample 是一次历史任务给出的吞吐样本。
type aiEstimateSample struct {
	images        int
	perImage      float64
	moduleVersion string
}

// Estimate 统计各分析模块在增量与全量模式下的待处理张数与预计耗时。
//
// 只读：不创建任务、不写状态文件、不碰队列。张数与任务实际会处理的张数
// 用同一条判据，所以这里数出来的增量张数就是任务开始后的 planned。
func (s *AIJobService) Estimate(ctx context.Context) (AIJobEstimate, error) {
	snapshot := s.catalog.Acquire()
	estimate := AIJobEstimate{
		GeneratedAt:     s.now(),
		LibraryRevision: snapshot.Revision(),
		LibraryReady:    snapshot.Ready(),
	}

	s.mu.Lock()
	modules := s.modulesLocked()
	peopleEnabled := s.settings.PeopleEnabled
	facts := make([]aiRecordFact, 0, len(s.records))
	for _, record := range s.records {
		facts = append(facts, aiRecordFact{
			resourceID:    record.ResourceID,
			moduleType:    record.Type,
			size:          record.Size,
			mtimeNs:       record.MTimeNs,
			moduleVersion: record.ModuleVersion,
			status:        record.Status,
		})
	}
	samples := s.estimateSamplesLocked()
	versions := make(map[string]string, len(s.analyzers))
	validators := make(map[string]AIAnalyzerRecordValidator, len(s.analyzers))
	for moduleType, analyzer := range s.analyzers {
		versions[moduleType] = analyzer.Version()
		validators[moduleType], _ = analyzer.(AIAnalyzerRecordValidator)
	}
	s.mu.Unlock()

	if !estimate.LibraryReady {
		estimate.Modules = estimateModules(modules, peopleEnabled, 0, nil, versions, samples)
		return estimate, nil
	}

	targets := s.targetsFor(ctx, snapshot)
	if err := ctx.Err(); err != nil {
		return AIJobEstimate{}, err
	}
	estimate.TotalImages = len(targets)

	stats := make(map[string]aiTargetStat, len(targets))
	for _, target := range targets {
		stats[target.resourceID] = aiTargetStat{size: target.size, mtimeNs: target.mtimeNs}
	}

	// 仍然有效的结果数：按模块各数一遍。待处理张数 = 目标总数 - 有效张数，
	// 与 selectTargets 的候选集完全等价。
	current := map[string]int{}
	for _, fact := range facts {
		stat, ok := stats[fact.resourceID]
		if !ok {
			// 文件已经不在库里，这条记录不再参与计数。
			continue
		}
		record := AIAnalysisRecord{
			Type:          fact.moduleType,
			ResourceID:    fact.resourceID,
			Size:          fact.size,
			MTimeNs:       fact.mtimeNs,
			ModuleVersion: fact.moduleVersion,
			Status:        fact.status,
		}
		target := aiJobTarget{resourceID: fact.resourceID, size: stat.size, mtimeNs: stat.mtimeNs}
		if aiRecordIsCurrent(record, true, target, versions[fact.moduleType], validators[fact.moduleType]) {
			current[fact.moduleType]++
		}
	}

	estimate.Modules = estimateModules(modules, peopleEnabled, estimate.TotalImages, current, versions, samples)
	estimate.Sequence = estimateSequence(estimate.Modules)
	return estimate, nil
}

// estimateModules 组装每个模块的两种模式结果。
func estimateModules(modules []AIJobModule, peopleEnabled bool, totalImages int, current map[string]int, versions map[string]string, samples map[string][]aiEstimateSample) []AIJobEstimateModule {
	result := make([]AIJobEstimateModule, 0, len(modules))
	for _, module := range modules {
		entry := AIJobEstimateModule{
			Type:      module.Type,
			Name:      module.Name,
			Installed: module.Installed,
			Available: module.Installed,
			Reason:    module.Reason,
			Version:   module.Version,
		}
		if module.Type == AIJobTypeFace && !peopleEnabled {
			entry.Available = false
			entry.Reason = "people_analysis_disabled"
		}
		if !entry.Available {
			// 模块现在跑不了，给数字反而误导：人脸结果在关闭人物分析时会被
			// 清掉，「增量 0 张」是假的。
			result = append(result, entry)
			continue
		}
		version := versions[module.Type]
		pending := 0
		if current != nil {
			pending = totalImages - current[module.Type]
		}
		rate, sampleImages, sampleCount := estimateMedianRate(samples[module.Type], version)
		entry.Incremental = &AIJobEstimateMode{
			Count:               pending,
			EstimatedDurationMs: estimateDuration(pending, rate, sampleCount > 0),
			SampleCount:         sampleCount,
			SampleImages:        sampleImages,
		}
		fullPending := totalImages
		entry.Full = &AIJobEstimateMode{
			Count:               fullPending,
			EstimatedDurationMs: estimateDuration(fullPending, rate, sampleCount > 0),
			SampleCount:         sampleCount,
			SampleImages:        sampleImages,
		}
		result = append(result, entry)
	}
	return result
}

// estimateSequence 汇总「按序启动全部任务」在两种模式下的张数与耗时。
func estimateSequence(modules []AIJobEstimateModule) AIJobEstimateSequence {
	sequence := AIJobEstimateSequence{}
	for _, mode := range []struct {
		name  string
		pick  func(AIJobEstimateModule) *AIJobEstimateMode
		apply func(*AIJobEstimateSequence, AIJobEstimateModule, *AIJobEstimateMode)
	}{
		{name: "incremental", pick: func(m AIJobEstimateModule) *AIJobEstimateMode { return m.Incremental }},
		{name: "full", pick: func(m AIJobEstimateModule) *AIJobEstimateMode { return m.Full }},
	} {
		total := AIJobEstimateTotal{Modules: []string{}}
		duration := int64(0)
		durationKnown := true
		for _, module := range modules {
			if !module.Available {
				continue
			}
			entry := mode.pick(module)
			if entry == nil {
				continue
			}
			total.Count += entry.Count
			total.Modules = append(total.Modules, module.Type)
			if entry.EstimatedDurationMs == nil {
				durationKnown = false
				continue
			}
			duration += *entry.EstimatedDurationMs
		}
		if durationKnown {
			total.EstimatedDurationMs = &duration
		}
		if mode.name == "incremental" {
			sequence.Incremental = total
		} else {
			sequence.Full = total
		}
	}
	return sequence
}

// estimateSamplesLocked 汇总各模块的历史吞吐样本。
//
// 样本来自持久化的任务记录：elapsedMs 与 speedPerSecond 不落盘，耗时要用
// startedAt / finishedAt 与实际分析张数重算。
func (s *AIJobService) estimateSamplesLocked() map[string][]aiEstimateSample {
	result := make(map[string][]aiEstimateSample)
	// 从新到旧遍历：样本要取最近几次，最近的运行最能代表当前这台机器。
	for index := len(s.order) - 1; index >= 0; index-- {
		job := s.jobs[s.order[index]]
		if job == nil || job.StartedAt == nil || job.FinishedAt == nil {
			continue
		}
		// 只取已经跑完的任务：中途取消的耗时分布失真。
		if job.Status != AIJobStatusCompleted && job.Status != AIJobStatusFailed {
			continue
		}
		images := job.Processed + job.Failed
		if images <= 0 {
			continue
		}
		duration := job.FinishedAt.Sub(*job.StartedAt)
		if duration <= 0 {
			continue
		}
		sample := aiEstimateSample{
			images:        images,
			perImage:      float64(duration.Milliseconds()) / float64(images),
			moduleVersion: job.ModuleVersion,
		}
		result[job.Type] = append(result[job.Type], sample)
	}
	return result
}

// estimateMedianRate 取历史样本每张耗时的中位数。
//
// 分层取样本：先要版本一致的、样本张数够多的；都没有再逐层放宽。
// 中位数而不是加权平均：一次跑了几千张的任务不该因为张数多就压过其它样本，
// 一次卡了两小时的任务也不该把整体拉偏。
func estimateMedianRate(samples []aiEstimateSample, version string) (rate float64, sampleImages int, sampleCount int) {
	if len(samples) == 0 {
		return 0, 0, 0
	}
	layers := []func(aiEstimateSample) bool{
		func(s aiEstimateSample) bool { return s.moduleVersion == version && s.images >= aiEstimateMinSampleImages },
		func(s aiEstimateSample) bool { return s.moduleVersion == version },
		func(s aiEstimateSample) bool { return s.images >= aiEstimateMinSampleImages },
		func(aiEstimateSample) bool { return true },
	}
	for _, accept := range layers {
		chosen := make([]aiEstimateSample, 0, len(samples))
		for _, sample := range samples {
			if accept(sample) {
				chosen = append(chosen, sample)
			}
		}
		if len(chosen) == 0 {
			continue
		}
		if len(chosen) > aiEstimateSampleLimit {
			chosen = chosen[:aiEstimateSampleLimit]
		}
		values := make([]float64, 0, len(chosen))
		for _, sample := range chosen {
			values = append(values, sample.perImage)
			sampleImages += sample.images
		}
		sort.Float64s(values)
		middle := len(values) / 2
		if len(values)%2 == 1 {
			rate = values[middle]
		} else {
			rate = (values[middle-1] + values[middle]) / 2
		}
		return rate, sampleImages, len(chosen)
	}
	return 0, 0, 0
}

// estimateDuration 按每张耗时推出预计耗时。没有可用样本时返回 nil ——
// 不给默认速度，也不把「算不出来」写成 0。
func estimateDuration(count int, perImage float64, known bool) *int64 {
	if !known || perImage <= 0 {
		return nil
	}
	if count <= 0 {
		zero := int64(0)
		return &zero
	}
	duration := int64(math.Round(float64(count) * perImage))
	return &duration
}

// targetsFor 返回当前媒体库的文件指纹清单，短时间复用上次采集的结果。
//
// 缓存只服务空闲时的规模预估：任务开跑必须用当下真实的 stat，否则文件刚
// 被改过时会被误判成「已经是最新的」而跳过重跑。
func (s *AIJobService) targetsFor(ctx context.Context, snapshot CatalogSnapshot) []aiJobTarget {
	revision := snapshot.Revision()
	s.targetCacheMu.Lock()
	cached := s.targetCache
	if cached != nil && cached.revision == revision && s.now().Sub(cached.builtAt) < aiTargetCacheTTL {
		s.targetCacheMu.Unlock()
		return cached.targets
	}
	s.targetCacheMu.Unlock()

	targets := s.buildTargets(ctx, snapshot)
	s.targetCacheMu.Lock()
	s.targetCache = &aiTargetCache{revision: revision, builtAt: s.now(), targets: targets}
	s.targetCacheMu.Unlock()
	return targets
}
