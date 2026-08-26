# Cover Letter Templates and Tailoring Guide

## Template: Custom cover.cls (XeLaTeX)

Cover letters use a custom LaTeX document class (`cover.cls`) with Lato/Raleway fonts.

**Output source:** `cover_letters/source/cover_<company>_<role>.tex`
**Compiled PDF:** `cover_letters/pdf/cover_<company>_<role>.pdf`
**Build artifacts:** `cover_letters/build/`
**Compile with:** XeLaTeX (`cover.cls` requires fontspec)

### Compile command

```bash
cd cover_letters && xelatex -interaction=nonstopmode cover_<company>_<role>.tex
```

Expected output: `Output written on cover_<company>_<role>.pdf (1 page, ...)`. Any page count other than 1 is a failure that must be fixed before presenting the letter.

## Compile-and-Inspect Loop

After writing the cover letter and before presenting it:

1. Run `xelatex -interaction=nonstopmode cover_<company>_<role>.tex`.
2. Confirm compilation succeeds and page count is exactly 1.
3. Inspect the PDF for a complete signature block, no clipped text, and consistent bullet typography.

## Known template pitfall: itemize inside \lettercontent{}

The `\lettercontent{}` macro appends `\\\\` to its argument. This breaks when the argument ends in `\end{itemize}` because there is no line to break after the environment closes.

**Wrong:**

```latex
\\lettercontent{Here is how my experience maps:
\\begin{itemize}
    \\item ...
\\end{itemize}}
```

**Correct:**

```latex
\\lettercontent{Here is how my experience maps:}

{\\raggedright\\fontspec[Path = OpenFonts/fonts/raleway/]{Raleway-Medium}\\fontsize{11pt}{13pt}\\selectfont
\\begin{itemize}
    \\item [Concrete achievement/skill 1]
    \\item [Concrete achievement/skill 2]
\\end{itemize}\\par}
\\vspace{6pt}
```

The matching font wrapper keeps bullets consistent with the body.

## Document Structure

```latex
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% Cover Letter - [Company], [Role]
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

\\documentclass[]{cover}
\\usepackage{fancyhdr}

\\pagestyle{fancy}
\\fancyhf{}
\\rfoot{Page \\thepage \\hspace{0pt}}
\\thispagestyle{empty}
\\renewcommand{\\headrulewidth}{0pt}
\\begin{document}

\\namesection{}{CANDIDATE NAME}{\\href{mailto:candidate@example.test}{candidate@example.test} | PHONE | \\urlstyle{same}\\href{https://linkedin.example/candidate}{LinkedIn}}

\\currentdate{\\today}
\\lettercontent{Dear [Name/Team],}
\\lettercontent{[Opening paragraph - role, connection to verified background, 2-3 sentences]}
\\lettercontent{[Body paragraph - most relevant verified experience, then bullet list]}

{\\raggedright\\fontspec[Path = OpenFonts/fonts/raleway/]{Raleway-Medium}\\fontsize{11pt}{13pt}\\selectfont
\\begin{itemize}
    \\item [Concrete achievement/skill 1]
    \\item [Concrete achievement/skill 2]
    \\item [Concrete achievement/skill 3]
\\end{itemize}\\par}
\\vspace{6pt}

\\lettercontent{[Connection to the company and role]}
\\lettercontent{[Personal fit paragraph grounded in verified evidence]}
\\lettercontent{I look forward to hearing from you.}

\\begin{flushright}
\\closing{Kind regards,}
\\signature{CANDIDATE NAME}
\\end{flushright}
\\end{document}
```

## Key Commands

| Command | Purpose |
|---------|---------|
| `\\namesection{}{Name}{contact info}` | Header with name and contact info |
| `\\currentdate{date}` | Date field |
| `\\lettercontent{text}` | Body paragraph with spacing |
| `\\closing{text}` | Closing line |
| `\\signature{name}` | Printed name below the closing |

## Tailoring Guidelines

### Salutation

- If the hiring manager is named, use their name.
- Otherwise use the company or team name.
- Avoid generic filler such as "To whom it may concern".

### Length

- Target one page including the signature block.
- Keep the body around 250-300 words.
- Trim existing content when adding company-specific material.

### Bullet Lists

- Keep the list outside `\\lettercontent{}`.
- Wrap it in the matching Raleway-Medium font.
- Use 3-5 verified, complementary points.
- Do not repeat an achievement already stated in a paragraph.

### LaTeX and language

- Escape LaTeX special characters such as `_` and `&`.
- Match the posting's language and local date/closing convention.

## Checklist Before Finalizing

- [ ] No em-dashes or empty filler
- [ ] Every claim is backed by verified evidence
- [ ] Company name and role are correct throughout
- [ ] Motivation is specific to the company and role
- [ ] Salutation is appropriate
- [ ] Date is current
- [ ] Fits on one page

## Submission Guidelines

- Submit only the documents the employer requests.
- Export as PDF to preserve formatting.
- Use generic filenames until the candidate has confirmed the final name.
- Follow employer instructions about anonymity and required materials.
