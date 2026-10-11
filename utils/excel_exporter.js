/**
 * FB 智能贴文自动回复与私信大师 - Excel / CSV 导出会话工具
 */

const ExcelExporter = {
  /**
   * 防御 CSV 公式注入 (Formula Injection / CWE-1236)
   * 若单元格以 '=', '+', '-', '@', '\t', '\r' 开头，前置单引号转义，防止 Excel 自动执行公式或 DDE
   */
  sanitizeCsvCell(val) {
    if (val === null || val === undefined) return '""';
    let str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return `"${str.replace(/"/g, '""')}"`;
  },

  /**
   * 将日志数组导出为 CSV 文件 (带有 UTF-8 BOM，原生支持 Excel 打开中文不乱码)
   */
  exportLogsToCSV(logs, filename = 'FB_AutoResponder_Logs.csv') {
    if (!logs || logs.length === 0) {
      alert("当前没有可导出的日志数据！");
      return;
    }

    const headers = [
      "序号",
      "记录时间",
      "留言用户",
      "匹配关键词",
      "留言内容",
      "私信触发状态",
      "公开评论状态",
      "贴文链接",
      "日志级别"
    ];

    const rows = logs.map((item, index) => [
      index + 1,
      this.sanitizeCsvCell(item.timestamp),
      this.sanitizeCsvCell(item.userName),
      this.sanitizeCsvCell(item.matchedKeyword),
      this.sanitizeCsvCell(item.commentText),
      this.sanitizeCsvCell(item.dmStatus),
      this.sanitizeCsvCell(item.commentStatus),
      this.sanitizeCsvCell(item.postUrl),
      this.sanitizeCsvCell(item.level || 'info')
    ]);

    // UTF-8 BOM
    const BOM = "\uFEFF";
    const csvContent = BOM + [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

if (typeof window !== 'undefined') {
  window.ExcelExporter = ExcelExporter;
}
