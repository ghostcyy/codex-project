import os
import re

# Plan mapping
plan = {
    '01-tech-web3': {'2-cards': {15: 'B'}, '5-cards': {18: True}},
    '02-finance-stablecoin': {'2-cards': {10: 'A'}, '5-cards': {16: True}},
    '03-medical-ai': {'2-cards': {18: 'B'}, '5-cards': {10: True}},
    '04-edu-adaptive': {'2-cards': {15: 'A'}, '5-cards': {}},
    '05-art-nft': {'2-cards': {18: 'B'}, '5-cards': {}},
    '06-realestate-smart': {'2-cards': {10: 'A', 14: 'B'}, '5-cards': {19: True}},
    '07-industry-edge': {'2-cards': {15: 'A'}, '5-cards': {19: True}},
    '08-eco-carbon': {'2-cards': {13: 'A', 16: 'B'}, '5-cards': {18: True}},
    '09-fashion-ar': {'2-cards': {15: 'B'}, '5-cards': {18: True}},
    '10-gov-smartcity': {'2-cards': {15: 'A'}, '5-cards': {18: True}},
    '11-corporate-consulting': {'2-cards': {6: 'A', 10: 'B'}, '5-cards': {}},
    '12-creative-portfolio': {'2-cards': {15: 'B'}, '5-cards': {18: True}},
    '14-space-economy': {'2-cards': {15: 'A', 19: 'B'}, '5-cards': {18: True}},
    '15-future-mobility': {'2-cards': {18: 'B'}, '5-cards': {16: True}},
    '16-sports-science': {'2-cards': {18: 'B'}, '5-cards': {16: True}},
    '17-cyber-security': {'2-cards': {18: 'B'}, '5-cards': {16: True}},
    '18-wellness-zen': {'2-cards': {18: 'B'}, '5-cards': {16: True}},
    '19-interior-design': {'2-cards': {18: 'B'}, '5-cards': {16: True}},
    '20-rogue-ai': {'2-cards': {18: 'B'}, '5-cards': {16: True}},
    '21-ocean-deep-blue': {'2-cards': {18: 'A'}, '5-cards': {6: True}},
    '22-quantum-computing': {'2-cards': {18: 'A'}, '5-cards': {6: True}},
    '23-luxury-ecommerce': {'2-cards': {}, '5-cards': {6: True}},
    '24-fresh-ecommerce': {'2-cards': {15: 'B'}, '5-cards': {6: True}},
    '25-home-essentials': {'2-cards': {15: 'B'}, '5-cards': {6: True}},
    '28-outdoor-adventure-retail': {'2-cards': {}, '5-cards': {6: True}},
}

css_template = """
/* --- Diversity Layouts (v2) --- */
.{prefix} .layout-pentagon {{
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 20px;
  flex: 1;
  padding: 20px;
}}
.{prefix} .layout-pentagon .card:nth-child(1) {{ grid-area: 1 / 1 / 2 / 2; transform: translate(20px, 20px); border-bottom: 4px solid var(--primary); }}
.{prefix} .layout-pentagon .card:nth-child(2) {{ grid-area: 1 / 3 / 2 / 4; transform: translate(-20px, 20px); border-bottom: 4px solid var(--secondary); }}
.{prefix} .layout-pentagon .card:nth-child(3) {{ grid-area: 2 / 1 / 3 / 2; transform: translate(20px, -20px); border-top: 4px solid var(--accent); }}
.{prefix} .layout-pentagon .card:nth-child(4) {{ grid-area: 2 / 3 / 3 / 4; transform: translate(-20px, -20px); border-top: 4px solid var(--primary); }}
.{prefix} .layout-pentagon .card:nth-child(5) {{
  grid-area: 1 / 2 / 3 / 3;
  z-index: 20;
  background: var(--surface);
  border: 2px solid var(--text-main);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
}}

.{prefix} .layout-split-v2 {{
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 100%;
  gap: 0;
}}
.{prefix} .layout-split-v2 .card {{
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 60px;
  border: none;
  border-radius: 0;
  transition: all 0.5s ease;
}}
.{prefix} .layout-split-v2 .card:nth-child(1) {{
  background: var(--surface);
  clip-path: polygon(0 0, 100% 0, 85% 100%, 0 100%);
  margin-right: -10%;
  z-index: 2;
}}
.{prefix} .layout-split-v2 .card:nth-child(2) {{
  background: var(--primary);
  clip-path: polygon(15% 0, 100% 0, 100% 100%, 0 100%);
  color: #fff;
  z-index: 1;
  padding-left: 120px;
}}
.{prefix} .layout-split-v2 .card:hover {{ transform: scale(1.02); z-index: 10; }}

.{prefix} .layout-overlap-diag {{
  position: relative;
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
}}
.{prefix} .layout-overlap-diag .card {{
  position: absolute;
  width: 45%;
  height: 60%;
  padding: 40px;
  transition: all 0.6s cubic-bezier(0.165, 0.84, 0.44, 1);
  display: flex;
  flex-direction: column;
  justify-content: center;
}}
.{prefix} .layout-overlap-diag .card:nth-child(1) {{
  top: 10%; left: 10%;
  background: var(--surface);
  border: 4px solid var(--primary);
  z-index: 1;
}}
.{prefix} .layout-overlap-diag .card:nth-child(2) {{
  bottom: 10%; right: 10%;
  background: var(--bg);
  border: 2px solid var(--secondary);
  z-index: 2;
  box-shadow: -20px -20px 0 rgba(0,0,0,0.2);
}}
.{prefix} .layout-overlap-diag .card:hover {{
  transform: translate(-10px, -10px);
  z-index: 100;
  box-shadow: 20px 20px 40px rgba(0,0,0,0.3);
}}
"""

def process_all(base_path):
    for tpl_folder, tpl_plan in plan.items():
        tpl_path = os.path.join(base_path, tpl_folder)
        index_file = os.path.join(tpl_path, 'index.html')
        style_file = os.path.join(tpl_path, 'style.css')

        if not os.path.exists(index_file) or not os.path.exists(style_file):
            continue

        print(f"Processing {tpl_folder}...")

        # 1. Update style.css
        with open(index_file, 'r', encoding='utf-8') as f:
            index_content = f.read()

        prefix_match = re.search(r'class="(tpl-[^"]+)"', index_content)
        if not prefix_match:
            continue
        prefix = prefix_match.group(1)

        with open(style_file, 'r', encoding='utf-8') as f:
            style_content = f.read()

        if ".layout-pentagon" not in style_content:
            with open(style_file, 'a', encoding='utf-8') as f:
                f.write(css_template.format(prefix=prefix))

        # 2. Update index.html
        slides = re.split(r'(<section[^>]+class="slide")', index_content)
        new_slides = [slides[0]]

        current_slide_idx = 0
        for i in range(1, len(slides), 2):
            header = slides[i]
            body = slides[i+1]

            # Find slide number
            num_match = re.search(r'data-current="(\d+)"', body)
            if num_match:
                slide_num = int(num_match.group(1))

                # Check plan
                if slide_num in tpl_plan['2-cards']:
                    style = tpl_plan['2-cards'][slide_num]
                    layout_class = "layout-split-v2" if style == 'A' else "layout-overlap-diag"
                    # Replace grid-2 or grid-layout-sidebar
                    body = re.sub(r'class="(grid-2|grid-layout-sidebar|grid-sidebar)"', f'class="{layout_class}"', body)
                    # Update kicker
                    kicker = "INTERLOCK_SPLIT" if style == 'A' else "KINETIC_OVERLAP"
                    body = re.sub(r'<span class="kicker">[^<]+</span>', f'<span class="kicker">{kicker}</span>', body)
                    body = re.sub(r'<div class="kicker">[^<]+</div>', f'<div class="kicker">{kicker}</div>', body)

                elif slide_num in tpl_plan['5-cards']:
                    # Replace grid-5
                    body = re.sub(r'class="grid-5"', 'class="layout-pentagon"', body)
                    # Update kicker
                    body = re.sub(r'<span class="kicker">[^<]+</span>', '<span class="kicker">PENTAGON_FOCUS</span>', body)
                    body = re.sub(r'<div class="kicker">[^<]+</div>', '<div class="kicker">PENTAGON_FOCUS</div>', body)

            new_slides.append(header)
            new_slides.append(body)

        with open(index_file, 'w', encoding='utf-8') as f:
            f.write("".join(new_slides))

if __name__ == "__main__":
    path = r"c:\Users\YuanYuan\Person\Software\Codex\.agents\skills\html-ppt\templates\full-decks\gemini"
    process_all(path)
