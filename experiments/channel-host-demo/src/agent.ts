/**
 * Agent — 消息处理逻辑（stub）
 *
 * 当前实现：固定回复"我知道了"
 * 后续：替换 processMessage 为真实的 AI 调用（LLM API、langchain 等）
 */

import type { InboundMessage } from "./types.js";

/**
 * 处理入站消息，返回回复文本
 *
 * @param msg  标准化的入站消息（来自任意 channel 插件）
 * @returns    回复文本
 *
 * 扩展点：
 *   - 替换为 OpenAI/Anthropic/本地 LLM 调用
 *   - 添加 session 管理（msg.from + msg.channel 作为 session key）
 *   - 添加工具调用能力
 */
export async function processMessage(msg: InboundMessage): Promise<string> {
  console.log(
    `[agent] processing message from "${msg.from}" via channel "${msg.channel}": ${msg.text}`,
  );

  // TODO: 替换为真实 AI 调用
  // 示例：
  // const response = await openai.chat.completions.create({
  //   model: "gpt-4o",
  //   messages: [{ role: "user", content: msg.text }],
  // });
  // return response.choices[0].message.content ?? "（无回复）";

  return "我知道了";
}
