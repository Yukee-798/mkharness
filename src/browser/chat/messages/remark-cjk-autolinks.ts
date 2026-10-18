import type { Link, Parent, PhrasingContent, Root } from 'mdast';

const prosePunctuation = /[，。；！？：、（）［］【】《》〈〉「」『』“”‘’]/u;
const bareUrl = /(?:https?:\/\/|www\.)/giu;

/** GFM's literal autolinks do not treat Chinese prose punctuation as a URL boundary. */
export function remarkCjkAutolinks() {
  return (tree: Root, file: { toString(): string }) => {
    const source = String(file);
    function visit(parent: Parent) {
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index]!;
        if (node.type !== 'link') {
          if ('children' in node) visit(node);
          continue;
        }
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        // Only repair generated literal links. Explicit, reference and <URL>
        // links retain their authored labels and destinations, including punctuation.
        if (
          !/^(?:https?:\/\/|www\.)/iu.test(raw) ||
          node.children.length !== 1 ||
          node.children[0]?.type !== 'text' ||
          node.children[0].value !== raw ||
          !prosePunctuation.test(raw)
        )
          continue;
        const replacement: PhrasingContent[] = [];
        let cursor = 0;
        bareUrl.lastIndex = 0;
        for (let match; (match = bareUrl.exec(raw));) {
          const start = match.index;
          if (start && !prosePunctuation.test(raw[start - 1]!)) continue;
          const boundary = raw.slice(start).search(prosePunctuation);
          const end = boundary < 0 ? raw.length : start + boundary;
          if (cursor < start) replacement.push({ type: 'text', value: raw.slice(cursor, start) });
          const label = raw.slice(start, end);
          const link: Link = {
            type: 'link',
            url: /^www\./iu.test(label) ? `http://${label}` : label,
            children: [{ type: 'text', value: label }],
          };
          replacement.push(link);
          cursor = end;
          bareUrl.lastIndex = end;
        }
        if (cursor < raw.length) replacement.push({ type: 'text', value: raw.slice(cursor) });
        parent.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    }
    visit(tree);
  };
}
