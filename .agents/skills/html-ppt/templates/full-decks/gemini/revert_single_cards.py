import os
import re

# Strict Stats from previous run (Pure Text)
stats = {
    '01-tech-web3': {'2-cards': [3, 15], '5-cards': [7, 18]},
    '02-finance-stablecoin': {'2-cards': [10], '5-cards': [9, 16]},
    '03-medical-ai': {'2-cards': [18], '5-cards': [10]},
    '04-edu-adaptive': {'2-cards': [13, 15], '5-cards': []},
    '05-art-nft': {'2-cards': [13, 18], '5-cards': []},
    '06-realestate-smart': {'2-cards': [7, 10, 14, 18], '5-cards': [19]},
    '07-industry-edge': {'2-cards': [3, 15], '5-cards': [19]},
    '08-eco-carbon': {'2-cards': [10, 13, 16, 19], '5-cards': [18]},
    '09-fashion-ar': {'2-cards': [3, 15], '5-cards': [8, 18]},
    '10-gov-smartcity': {'2-cards': [3, 15], '5-cards': [7, 18]},
    '11-corporate-consulting': {'2-cards': [4, 6, 9, 10], '5-cards': []},
    '12-creative-portfolio': {'2-cards': [15], '5-cards': [18]},
    '14-space-economy': {'2-cards': [3, 15, 19], '5-cards': [18]},
    '15-future-mobility': {'2-cards': [3, 18], '5-cards': [16]},
    '16-sports-science': {'2-cards': [3, 18], '5-cards': [16]},
    '17-cyber-security': {'2-cards': [3, 18], '5-cards': [16]},
    '18-wellness-zen': {'2-cards': [3, 18], '5-cards': [16]},
    '19-interior-design': {'2-cards': [3, 18], '5-cards': [16]},
    '20-rogue-ai': {'2-cards': [3, 18], '5-cards': [16]},
    '21-ocean-deep-blue': {'2-cards': [18], '5-cards': [6]},
    '22-quantum-computing': {'2-cards': [18], '5-cards': [6]},
    '23-luxury-ecommerce': {'2-cards': [], '5-cards': [6]},
    '24-fresh-ecommerce': {'2-cards': [15], '5-cards': [6]},
    '25-home-essentials': {'2-cards': [15], '5-cards': [6]},
    '28-outdoor-adventure-retail': {'2-cards': [], '5-cards': [6]},
}

def revert_if_needed(base_path):
    for tpl_folder, data in stats.items():
        index_file = os.path.join(base_path, tpl_folder, 'index.html')
        if not os.path.exists(index_file): continue

        revert_2 = len(data['2-cards']) == 1
        revert_5 = len(data['5-cards']) == 1

        if not revert_2 and not revert_5: continue

        print(f"Checking reversions for {tpl_folder} (Revert 2: {revert_2}, Revert 5: {revert_5})...")

        with open(index_file, 'r', encoding='utf-8') as f:
            content = f.read()

        slides = re.split(r'(<section[^>]+class="slide")', content)
        new_slides = [slides[0]]

        for i in range(1, len(slides), 2):
            header = slides[i]
            body = slides[i+1]

            num_match = re.search(r'data-current="(\d+)"', body)
            if num_match:
                slide_num = int(num_match.group(1))

                if revert_2 and slide_num in data['2-cards']:
                    print(f"  Reverting 2-card Slide {slide_num}")
                    body = re.sub(r'class="(layout-split-v2|layout-overlap-diag)"', 'class="grid-2"', body)
                    # Attempt to restore a generic kicker or just remove the fake one
                    # Since we don't know the exact original kicker, we'll try to find common ones or keep a simplified one
                    body = re.sub(r'INTERLOCK_SPLIT|KINETIC_OVERLAP', 'CORE_INFO', body)

                if revert_5 and slide_num in data['5-cards']:
                    print(f"  Reverting 5-card Slide {slide_num}")
                    body = re.sub(r'class="layout-pentagon"', 'class="grid-5"', body)
                    body = re.sub(r'PENTAGON_FOCUS', 'SYSTEM_ARCHITECTURE', body)

            new_slides.append(header)
            new_slides.append(body)

        with open(index_file, 'w', encoding='utf-8') as f:
            f.write("".join(new_slides))

if __name__ == "__main__":
    path = r"c:\Users\YuanYuan\Person\Software\Codex\.agents\skills\html-ppt\templates\full-decks\gemini"
    revert_if_needed(path)
