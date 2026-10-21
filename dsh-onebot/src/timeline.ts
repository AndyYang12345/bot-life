import type { MediaHistory } from '@local/qqbot-life';
/** Evidence, not a guessed caption: quote repeats never become newly uploaded pictures. */
export function imageTimeline(rows: MediaHistory[]): string {
  const facts = rows.map((row, n) => `- ${n === rows.length - 1 ? '最近一张用户直接发送的图片' : '较早的图片'}; time=${row.occurredAt}; event_id=${row.eventId}; local_path=${row.path}`).join('\n');
  return '当前会话最近图片索引（来自本地账本，按实际接收顺序从旧到新；引用同一张图不改变原图顺序）：\n'
    + (facts || '当前上下文范围没有已记录的历史原图。')
    + '\n用户问“上一张图/刚才的图”且本条没有指定引用时，以索引最后一项为指代对象，调用 read_image 核验；如果用户本条有明确引用，以该引用为准。不要用历史回答里的“上一张”来重排图片，不要补造索引以外图片的先后。这个索引不代表已实现长期记忆。';
}
