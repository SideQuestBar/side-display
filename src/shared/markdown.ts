/**
 * A deliberately small Markdown renderer for on-screen text: headings, bold,
 * italic, inline code, links, lists and line breaks. Everything is HTML-escaped
 * first, so the output is safe to inject.
 */
const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(text: string): string {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/~~([^~]+)~~/g, "<s>$1</s>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(source: string | null | undefined): string {
	const text = (source ?? "").replace(/\r\n?/g, "\n").trim();
	if (!text) return "";
	const out: string[] = [];
	let paragraph: string[] = [];
	let list: string[] = [];
	const flush = () => {
		if (paragraph.length) out.push(`<p>${paragraph.join("<br>")}</p>`);
		if (list.length) out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
		paragraph = [];
		list = [];
	};
	for (const line of text.split("\n")) {
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		const item = /^\s*[-*]\s+(.*)$/.exec(line);
		if (!line.trim()) flush();
		else if (heading) {
			flush();
			out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
		} else if (item) {
			if (paragraph.length) flush();
			list.push(inline(item[1]!));
		} else {
			if (list.length) flush();
			paragraph.push(inline(line));
		}
	}
	flush();
	return out.join("");
}
