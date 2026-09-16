import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface MathTextProps {
  content: string;
  className?: string;
}

export function MathText({ content, className = '' }: MathTextProps) {
  if (!content) return null;

  // Split content by LaTeX inline ($...$) or block ($$...$$) delimitations
  const parts = content.split(/(\$\$[\s\S]*?\$\$|\$[\s\S]*?\$)/g);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.startsWith('$$') && part.endsWith('$$')) {
          const math = part.slice(2, -2);
          try {
            const html = katex.renderToString(math, { displayMode: true, throwOnError: false });
            return <span key={index} dangerouslySetInnerHTML={{ __html: html }} className="my-2 block overflow-x-auto" />;
          } catch (e) {
            return <code key={index}>{part}</code>;
          }
        } else if (part.startsWith('$') && part.endsWith('$')) {
          const math = part.slice(1, -1);
          try {
            const html = katex.renderToString(math, { displayMode: false, throwOnError: false });
            return <span key={index} dangerouslySetInnerHTML={{ __html: html }} className="inline-block px-0.5" />;
          } catch (e) {
            return <code key={index}>{part}</code>;
          }
        }
        return <span key={index}>{part}</span>;
      })}
    </span>
  );
}

export default function Logo() {
  return (
    <div className="flex items-center gap-2 select-none cursor-pointer">
      {/* Mini Icon Badge */}
      <div className="bg-[#FFE600] text-black font-black text-sm px-2 py-1 rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
        BP
      </div>

      {/* Brand Text */}
      <div className="flex items-center text-2xl md:text-3xl font-black tracking-tight">
        <span className="text-black">Bikin</span>
        <span className="text-[#C084FC] [text-shadow:_2px_2px_0_#000]">Paham</span>
      </div>

      {/* Suffix Badge */}
      <span className="bg-[#FFE600] text-black font-black text-xs md:text-sm px-2 py-0.5 rounded-lg border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] -rotate-6 transition-transform hover:rotate-0">
        .ai
      </span>
    </div>
  );
}


