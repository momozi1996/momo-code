
```markdown
███╗   ███╗ ██████╗ ███╗   ███╗ ██████╗    ██████╗ ██████╗ ██████╗ ███████╗
████╗ ████║██╔═══██╗████╗ ████║██╔═══██╗  ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██╔████╔██║██║   ██║██╔████╔██║██║   ██║  ██║     ██║   ██║██║  ██║█████╗  
██║╚██╔╝██║██║   ██║██║╚██╔╝██║██║   ██║  ██║     ██║   ██║██║  ██║██╔══╝  
██║ ╚═╝ ██║╚██████╔╝██║ ╚═╝ ██║╚██████╔╝  ╚██████╗╚██████╔╝██████╔╝███████╗
╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝ ╚═════╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝

```

# MOMO CODE 🔥v1.0.0
<div align="center">
<!-- 开源标准状态徽章 -->
[![发布版本](https://img.shields.io/github/v/release/momozi1996/momo-code?label=Release&color=orange)](https://github.com/momozi1996/momo-code/releases)
[![Star收藏](https://img.shields.io/github/stars/momozi1996/momo-code?style=flat)](https://github.com/momozi1996/momo-code/stargazers)
[![Fork分支](https://img.shields.io/github/forks/momozi1996/momo-code)](https://github.com/momozi1996/momo-code/forks)
[![开源协议](https://img.shields.io/github/license/momozi1996/momo-code)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org/)
[![NPM包版本](https://img.shields.io/npm/v/@momo/cli)](https://www.npmjs.com/package/@momo/cli)

<br/>

<!-- 导航图标，URL占位和英文文档统一 -->
<a href="https://momozi.cc" target="_blank">
  <img src="https://img.shields.io/badge/website-momozi.cc-blue" alt="官方网站"/>
</a>
&nbsp;&nbsp;
<a href="https://huggingface.co/momozi" target="_blank">
  <img src="https://cdn.jsdelivr.net/npm/simple-icons@v12/icons/huggingface.svg" width="24" alt="Hugging Face"/>
</a>
&nbsp;&nbsp;
<a href="./README.md" target="_self">
  <img src="https://img.shields.io/badge/docs-EN-orange" alt="English"/>
</a>
<p>
  <a href="https://momozi.cc">官方网站</a> · 
  <a href="https://huggingface.co/momozi">Hugging Face</a> · 
  <a href="./README.md">English Docs</a>
</p>
</div>

AI 驱动的智能编程代理，随你的开发持续进化。
基于 OpenCode 构建，搭载一套独创、基于先锋智能体的双速自主进化系统。

## 目录
- [核心特性](#核心特性)
- [安装教程](#安装教程)
- [快速上手](#快速上手)
- [基础使用](#基础使用)
- [CLI 命令大全](#cli-命令大全)
- [配置说明](#配置说明)
- [快速经验进化循环 `/evolve`](#快速经验进化循环-evolve)
- [自主微调训练 `/fine-tune`](#自主微调训练-fine-tune)
- [从 Claude Code 迁移](#从-claude-code-迁移)
- [环境变量](#环境变量)
- [架构设计](#架构设计)
- [更新日志](#更新日志)
- [开源协议](#开源协议)

## 核心特性
- 支持25+主流大模型服务商：DeepSeek、智谱GLM、月之暗面Kimi、Claude、GPT-4、Gemini、豆包、OpenRouter、Groq、Mistral 等
- 自定义服务商支持：通过 `MOMO_CUSTOM_*` 系列环境变量接入任意兼容 OpenAI 协议的 API
- 模型分级：零配置切换 `ultra` / `standard` / `lite` 三档模型
- 秒级快速经验进化 `/evolve`：基于 KEP 知识嵌入协议实现提示词注入，通过汤普森采样自动筛选高成功率开发策略
- 小时级自主微调训练 `/fine-tune`：蒙特卡洛图搜索(MCGS)+LoRA 轻量化微调持续优化模型权重
- 图引擎多智能体编排 `/graph`：LLM 自动规划任务 DAG，自动创建多个子 agent 并行执行、失败重试、断点续跑，支持长程任务（可混入 `/sim` 仿真子 agent）
- 完美兼容 Claude Code：无缝迁移，自动复用 `.claude/` 配置、MCP 服务、自定义提示词
- 本地优先：所有代码数据留存本地，开源可审计，无数据外漏风险
- Effect 架构驱动：可组合、类型安全的标准化代码实现

## 安装教程
### 环境前置要求
Node.js >= 20.0.0
npm >= 10.0

### NPM 全局安装
```bash
npm install -g @momo/cli
```

### 源码编译安装
```bash
git clone https://github.com/momozi1996/momo-code.git
cd momo-code/packages/opencode
npm install
npm run build
```

### macOS / Linux 一键快速安装
```bash
curl -fsSL https://momozi.cc/install | bash
```

## 快速上手
### 1. 配置 API 密钥
```bash
# 通用密钥（适配所有服务商）
export MOMO_API_KEY=你的API密钥

# 服务商专属密钥（优先级更高）
export MOMO_ANTHROPIC_API_KEY=sk-ant-...
export MOMO_OPENAI_API_KEY=sk-...
```

### 2. 启动编程助手
```bash
# 交互式对话模式
momo

# 单次执行任务
momo "使用Effect重构鉴权模块"

# 指定模型分级执行任务
momo --model ultra "复杂架构评审"
momo --model standard "修复登录Bug"
momo --model lite "快速代码审查"
```

### 3. 首次运行目录初始化
首次执行 momo 会在用户目录生成 `.momo` 配置文件夹：
```
~/.momo/
├── momo.jsonc          # 主配置文件
├── sessions/           # 对话会话历史
├── experience/         # 自动生成的学习策略库
│   ├── tactics.jsonl
│   └── ledger.jsonl
└── ...
```

## 基础使用
### 模型分级说明
| 分级 | 适用场景 |
|------|----------|
| `ultra` | 复杂开发任务、超长上下文需求 |
| `standard` | 日常常规编码工作 |
| `lite` | 简短快速任务、低延迟需求 |

### CLI 全局参数
```
momo [参数] [指令文本]

可选参数：
  --model, -m <id>       指定模型ID或分级
  --provider, -p <name>  指定大模型服务商
  --help                 展示帮助文档
  --version              查看当前版本
```

## CLI 命令大全
### 会话交互命令
```bash
momo                     # 进入交互式对话
momo "指令内容"            # 一次性执行任务
momo --model claude-sonnet-4 "开发任务"
```

### 快速经验进化 `/evolve`
```bash
momo /evolve                       # 默认配置执行进化学习
momo /evolve --mode=explore        # 优先探索全新开发策略
momo /evolve --mode=harden         # 优先复用经过验证的高成功率策略
momo /evolve --mode=convention-only # 仅学习代码规范类策略
momo /evolve --list                # 查看全部已学习策略
momo /evolve --inject              # 将学习策略注入当前会话提示词
momo /evolve --solidify            # 同步本次任务结果，更新策略胜率统计
```

### 自主微调训练 `/fine-tune`
```bash
momo /fine-tune              # 诊断训练数据，生成训练方案预览
momo /fine-tune run          # 执行完整微调训练流水线
momo /fine-tune run --dry-run # 仅预览流程，不实际训练
momo /fine-tune status       # 查询当前训练进度
momo /fine-tune promote      # 将训练完成的候选模型升级为正式生产模型
```

### 模型管理命令
```bash
momo models list         # 列出所有支持模型
momo models info <id>    # 查看指定模型详情
momo models providers    # 查看全部可用服务商
```

## 配置说明
### 主配置文件 `~/.momo/momo.jsonc`
```json
{
  "$schema": "https://momozi.cc/config.json",
  "model": "standard",
  "provider": "anthropic",
  "inheritClaudeCode": true,
  "evolve": {
    "enabled": true,
    "auto": false,
    "clusterThreshold": 10,
    "budgetUSD": 50
  }
}
```

## 快速经验进化循环 `/evolve`
经验快速循环（KEP 知识嵌入协议）是 MOMO CODE 独创的秒级学习系统。
和 `/fine-tune` 小时级微调权重不同，`/evolve` 通过提示词注入实现秒级学习与复用。

### 工作流程
1. 观测采集：从会话中提取任务反馈（测试通过/失败、代码修改采纳/驳回、人工修正）
2. 策略提炼：将成功开发模式压缩为标准化策略卡片
3. 策略筛选：汤普森采样算法平衡探索新策略、复用成熟策略
4. 提示注入：将最优Top-K策略写入当前任务系统提示词
5. 数据固化：根据任务结果更新策略Beta分布胜率统计
6. 升级推送：高置信度成熟策略自动送入微调训练数据集

### KEP 三大核心存储载体
| 载体 | 说明 |
|------|------|
| Tactic 策略卡片 | 包含触发条件、执行步骤、校验规则、边界约束的精简开发方案 |
| Case 成功案例 | 注入策略后完整执行成功的任务记录 |
| Ledger 审计日志 | 仅追加式JSONL操作日志，完整留存全部学习记录 |

### 策略胜率统计（Beta分布）
每条策略维护 Beta(α, β) 概率分布：
α = 1 + 成功次数，β = 1 + 失败次数
使用汤普森采样平衡探索与利用；UCB1 为备选筛选算法

### 进化模式
| 模式 | 行为说明 |
|------|----------|
| `balanced`（默认） | 均衡探索新策略与复用成熟策略 |
| `explore` | 侧重挖掘全新未知开发策略，扩大采样范围 |
| `harden` | 侧重复用经过大量验证的高胜率策略 |
| `convention-only` | 仅学习代码规范相关策略 |

### 持久化存储
所有学习策略存放于 `~/.momo/experience/`：
- `tactics.jsonl`：全部策略完整记录
- `ledger.jsonl`：全流程操作审计日志

### 对应环境变量
| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MOMO_XP_MODE` | 全局默认进化模式 | `balanced` |
| `MOMO_XP_DIR` | 学习数据存储目录 | `~/.momo/experience` |

## 自主微调训练 `/fine-tune`
权重慢速循环通过 LoRA 微调优化模型底层权重，训练周期为小时级。

### 工作流程
1. 信号挖掘：从历史会话提取有效训练样本
2. 训练集构建：组合优质样本、难负样本、历史回放样本生成训练课程
3. 蒙特卡洛图搜索 MCGS：遍历最优训练流水线参数组合
4. LoRA 轻量化微调：训练候选模型
5. 棘轮校验门控：保证模型效果单调提升，不允许效果倒退

### 训练命令
```bash
momo /fine-tune              # 诊断数据，输出训练方案
momo /fine-tune run          # 启动完整微调训练
momo /fine-tune run --dry-run # 预演流程，不实际训练
momo /fine-tune status       # 查看训练状态
momo /fine-tune promote      # 上线候选模型至生产环境
```

### 训练相关配置变量
| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MOMO_EVOLVE_ENABLED` | 开启自主进化功能 | `true` |
| `MOMO_EVOLVE_AUTO` | 自动触发定时微调训练 | `false` |
| `MOMO_EVOLVE_BUDGET_USD` | 单次训练最大预算（美元） | `50` |

## 从 Claude Code 迁移
零成本无缝迁移，默认全部自动启用：
- 配置继承（默认开启）：自动合并 `~/.claude/settings.json`
- MCP 服务（默认开启）：`.claude/mcp/` 下服务直接兼容使用
- 自定义提示词（默认开启）：`.claude/prompts/` 全部可用

```bash
# 关闭Claude Code配置继承
export MOMO_CLAUDE_CODE_INHERIT=false
export MOMO_ONLY=1
```

## 环境变量总表
| 变量名 | 说明 |
|--------|------|
| `MOMO_API_KEY` | 通用大模型API密钥 |
| `MOMO_HOME` | 程序根目录，默认 `~/.momo` |
| `MOMO_MODEL` | 默认使用模型/分级 |
| `MOMO_PROVIDER` | 默认大模型服务商 |
| `MOMO_XP_MODE` | 全局进化模式（balanced/explore/harden/convention-only） |
| `MOMO_XP_DIR` | 学习策略存储目录 |
| `MOMO_EVOLVE_ENABLED` | 总开关：启用自主进化 |
| `MOMO_EVOLVE_BUDGET_USD` | 微调训练预算上限 |
| `MOMO_ANTHROPIC_API_KEY` | Claude 服务商密钥 |
| `MOMO_OPENAI_API_KEY` | OpenAI 服务商密钥 |
| `MOMO_OPENROUTER_API_KEY` | OpenRouter 中转密钥 |

完整变量定义文件：`src/env.ts`

## 架构设计
### 双速自主进化架构
```
┌─────────────────────────────────────────────────────────┐
│                    momo Code                             │
├─────────────────────┬───────────────────────────────────┤
│ 快速经验循环        │ 权重慢速微调循环                   │
│ (/evolve)          │  (/fine-tune)                     │
├─────────────────────┼───────────────────────────────────┤
│ 执行周期：秒级     │ 执行周期：小时级                   │
│ 实现方式：提示词注入 │ 实现方式：LoRA轻量化微调        │
│ 策略筛选：汤普森/UCB │ 搜索算法：蒙特卡洛图搜索MCGS     │
│ 存储：JSONL本地文件 │ 训练载体：LoRA适配器              │
│ 目录：~/.momo/xp/  │ 校验机制：棘轮效果校验门控        │
│ 互通通道：成熟策略推送至微调数据集 │ 存储：模型仓库    │
└─────────────────────┴───────────────────────────────────┘
```

### 服务商调度层流程
```
用户请求
    |
    v
resolveModel("standard") → 读取内置分级模型列表
    |                           [claude-sonnet, gpt-4.1, ...]
    v
getCredentials() → 读取MOMO_*系列环境变量密钥
    |
    v
服务商工厂 → 生成接口地址、请求头、超时配置
    |
    v
createModel() → 统一大模型适配器
    |
    v
wrapSSE() → 流式响应封装，8分钟超时保护
```

### 项目源码目录结构
```
packages/opencode/src/
├── provider/       # 19家大模型服务商适配代码
├── evolve/         # 慢速微调模块 /fine-tune，MCGS实现
├── experience/     # 快速进化模块 /evolve，KEP协议实现
│   ├── tactic.ts       # 策略数据模型 + Beta胜率统计
│   ├── selector.ts     # 汤普森/UCB策略筛选器
│   ├── injector.ts     # 提示词注入逻辑
│   ├── gate.ts         # 策略升级校验门控
│   ├── bridge.ts       # 快慢循环互通桥梁
│   └── ...
├── cli/cmd/        # 全部CLI命令实现
├── session/        # 会话与提示词路由
├── config/         # 全局配置解析
└── effect/         # Effect函数式工具库
```

### 测试结果
- TypeScript 静态校验：`tsc --noEmit` 零报错
- 运行时单元测试：17/17 全部通过
- CLI 全命令验证：`/evolve`、`/fine-tune`、`models`、`help` 均可正常执行

## 更新日志
### v1.0.0 (2026-06-16)
#### 新增功能
1. 秒级快速经验进化 `/evolve`：KEP 知识嵌入协议 + 汤普森采样策略筛选
2. 小时级自主微调 `/fine-tune`：完整MCGS蒙特卡洛图搜索训练流水线
3. 全套CLI指令系统：`/evolve`、`/fine-tune`、`models`、`help`
4. 跨分层53个TypeScript标准化模块（服务商/进化/经验/命令行）
5. 双速自主进化核心架构
6. 策略Beta分布胜率追踪统计
7. 快慢循环互通通道：成熟策略自动导入微调训练集

#### 变更调整
1. 产品名称：kqq Code → momo Code
2. 入口脚本 bin/momo：CJS 重构为 ESM 命令路由
3. package.json：生产环境导出规范、文件白名单优化

## 开源协议
MIT 开源协议 — 第三方组件版权说明见 NOTICE 文件；限制条款见 USE_RESTRICTIONS.md；安全规范见 SECURITY.md
```
