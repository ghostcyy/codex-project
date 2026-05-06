import os
import re

def analyze_templates(base_path):
    results = {}
    for root, dirs, files in os.walk(base_path):
        if 'index.html' in files:
            tpl_name = os.path.basename(root)
            index_path = os.path.join(root, 'index.html')
            with open(index_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Split content into slides by <section
            # We want to catch the beginning of the section to find data-current
            slides = re.split(r'<section', content)

            tpl_stats = {'2-cards': [], '5-cards': []}

            for slide_content in slides[1:]: # Skip text before first slide
                # Extract data-current if possible
                num_match = re.search(r'data-current="(\d+)"', slide_content)
                if not num_match:
                    continue
                slide_num = int(num_match.group(1))

                # Check for excluded elements
                exclude_patterns = [
                    r'<canvas',
                    r'chart-container',
                    r'<table',
                    r'<audio',
                    r'<video',
                    r'<iframe',
                    r'<img'
                ]

                is_excluded = False
                for pattern in exclude_patterns:
                    if re.search(pattern, slide_content, re.IGNORECASE):
                        is_excluded = True
                        break

                if is_excluded:
                    continue

                # Count cards
                cards = re.findall(r'class="card"', slide_content)
                card_count = len(cards)

                if card_count == 2:
                    tpl_stats['2-cards'].append(slide_num)
                elif card_count == 5:
                    tpl_stats['5-cards'].append(slide_num)

            results[tpl_name] = tpl_stats

    return results

if __name__ == "__main__":
    path = r"c:\Users\YuanYuan\Person\Software\Codex\.agents\skills\html-ppt\templates\full-decks\gemini"
    stats = analyze_templates(path)

    print("Template Statistics (STRICT Pure Text Cards - Using data-current):")
    print("-" * 70)
    for tpl, data in sorted(stats.items()):
        if data['2-cards'] or data['5-cards']:
            line = f"{tpl:30} | 2-Cards: {str(data['2-cards']):20} | 5-Cards: {str(data['5-cards'])}"
            print(line)
