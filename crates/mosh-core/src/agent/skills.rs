//! 技能（Skills）：可启用的系统提示词片段，为 Agent 注入领域行为指引。
//!
//! 设计（对齐 cherry-studio 的技能面板，v1 本地化）：
//! - 技能 = `{id, name, description, prompt}`，启用后其 prompt 追加到系统提示词；
//! - 内置技能 [`builtin_skills`]（只读，可开关）；自定义技能持久化于 settings
//!   key=`ai_skills_custom`（src-tauri 侧读写），启用集合存 `ai_skills_active`；
//! - 本模块不含存储与 UI：纯定义 + 提示词拼装，便于单测。

use serde::{Deserialize, Serialize};

/// 一条技能定义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SkillDef {
    /// 稳定 id（内置技能固定；自定义为 uuid）。
    pub id: String,
    pub name: String,
    pub description: String,
    /// 追加到系统提示词的指引正文。
    pub prompt: String,
    /// 内置技能不可编辑/删除（仅可开关）。
    #[serde(default)]
    pub builtin: bool,
}

/// 内置技能集（v1：三个领域能力预设）。
pub fn builtin_skills() -> Vec<SkillDef> {
    vec![
        SkillDef {
            id: "planner".into(),
            name: "日程规划师".into(),
            description: "把模糊目标拆解为具体日程与待办，给出时间块建议".into(),
            prompt: "启用「日程规划师」技能：当用户提出目标（如“准备下月发布会”）时，\
先梳理出 3-6 个可执行步骤，再主动用 create_event / create_todo 落成具体时间点的日程与待办，\
并按“重要-紧急”给出安排顺序；时间冲突时提出调整建议。"
                .into(),
            builtin: true,
        },
        SkillDef {
            id: "organizer".into(),
            name: "待办整理".into(),
            description: "审查待办与日程，识别逾期与优先级错位，给出清理建议".into(),
            prompt: "启用「待办整理」技能：面对“帮我整理一下”类请求时，\
先用 list_todos / list_events 拉全量数据，按逾期、无截止、低优先级长期未动三类归组，\
逐组给出“完成 / 改期 / 取消（set_todo_status cancelled）”建议，用户确认后再执行。"
                .into(),
            builtin: true,
        },
        SkillDef {
            id: "weekly-report".into(),
            name: "周报助手".into(),
            description: "根据本周日程与完成的待办生成结构化周报草稿".into(),
            prompt: "启用「周报助手」技能：生成周报时先用 list_events / list_todos \
查询本周（周一至今）数据，按“本周完成 / 进行中 / 下周计划 / 风险与备注”四段输出 Markdown，\
数据只引用查询结果，不臆造。"
                .into(),
            builtin: true,
        },
    ]
}

/// 把启用的技能拼装为系统提示词追加段（无启用技能 → None）。
///
/// 格式：一级引导 + 每技能一节（名称 + 正文）。
pub fn skills_prompt(active: &[SkillDef]) -> Option<String> {
    if active.is_empty() {
        return None;
    }
    let mut out = String::from("\n\n以下技能已启用，请在对应场景遵循其附加指引：");
    for s in active {
        out.push_str(&format!("\n### 技能：{}\n{}", s.name, s.prompt));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_skills_shape() {
        let skills = builtin_skills();
        assert!(skills.len() >= 3);
        assert!(skills.iter().all(|s| s.builtin));
        assert!(skills.iter().all(|s| !s.prompt.is_empty()));
        // id 唯一。
        let mut ids: Vec<_> = skills.iter().map(|s| s.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), skills.len());
    }

    #[test]
    fn skills_prompt_empty_is_none() {
        assert!(skills_prompt(&[]).is_none());
    }

    #[test]
    fn skills_prompt_contains_sections() {
        let skills = builtin_skills();
        let p = skills_prompt(&skills[..1]).unwrap();
        assert!(p.contains("技能已启用"));
        assert!(p.contains(&format!("### 技能：{}", skills[0].name)));
        assert!(p.contains(&skills[0].prompt));
    }

    #[test]
    fn skill_def_serde_roundtrip_snake_case() {
        let s = SkillDef {
            id: "x".into(),
            name: "n".into(),
            description: "d".into(),
            prompt: "p".into(),
            builtin: false,
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"builtin\""));
        let back: SkillDef = serde_json::from_str(&j).unwrap();
        assert_eq!(back, s);
        // builtin 缺省 false。
        let no_builtin: SkillDef =
            serde_json::from_str(r#"{"id":"x","name":"n","description":"d","prompt":"p"}"#)
                .unwrap();
        assert!(!no_builtin.builtin);
    }
}
