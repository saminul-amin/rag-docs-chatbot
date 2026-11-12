"""Generates the demo's sample documents in /sample-docs.

Kettlewick Coffee Co. is a fictional company invented for this demo. Every policy,
number and product below is made up.

    pip install reportlab
    python scripts/make-sample-docs.py
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (PageBreak, Paragraph, SimpleDocTemplate, Spacer,
                                Table, TableStyle)

OUT = Path(__file__).resolve().parent.parent / "sample-docs"
OUT.mkdir(exist_ok=True)

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], textColor=colors.HexColor("#3b2a1a"))
H2 = ParagraphStyle("H2", parent=styles["Heading2"], textColor=colors.HexColor("#6b4423"), spaceBefore=10)
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=10.5, leading=15)
NOTE = ParagraphStyle("Note", parent=BODY, textColor=colors.grey, fontSize=9)


def build(filename, title, blocks):
    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.grey)
        canvas.drawString(20 * mm, 12 * mm, f"Kettlewick Coffee Co. (fictional demo company) - {title}")
        canvas.drawRightString(190 * mm, 12 * mm, f"Page {doc.page}")
        canvas.restoreState()

    story = []
    for kind, value in blocks:
        if kind == "h1":
            story.append(Paragraph(value, H1))
        elif kind == "h2":
            story.append(Paragraph(value, H2))
        elif kind == "p":
            story.append(Paragraph(value, BODY))
            story.append(Spacer(1, 4))
        elif kind == "note":
            story.append(Paragraph(value, NOTE))
            story.append(Spacer(1, 6))
        elif kind == "ul":
            for item in value:
                story.append(Paragraph(f"&bull; {item}", BODY))
            story.append(Spacer(1, 4))
        elif kind == "table":
            cell = ParagraphStyle("Cell", parent=BODY, fontSize=9.5, leading=12)
            rows = [[Paragraph(str(c), cell) for c in row] for row in value]
            t = Table(rows, hAlign="LEFT", colWidths=[18 * mm, 55 * mm, 97 * mm])
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#efe6dc")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbb8a4")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]))
            story.append(t)
            story.append(Spacer(1, 6))
        elif kind == "break":
            story.append(PageBreak())
    doc = SimpleDocTemplate(str(OUT / filename), pagesize=A4, title=title,
                            leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print("wrote", filename)


HANDBOOK = [
    ("h1", "Kettlewick Coffee Co. Employee Handbook"),
    ("note", "Version 4.2, effective 1 March 2026. Kettlewick Coffee Co. is a fictional company used for demonstration."),
    ("h2", "1. Welcome"),
    ("p", "Kettlewick roasts specialty coffee in small batches and sells it through our online store, "
          "three cafes and a wholesale programme for restaurants. This handbook explains how we work, "
          "what you can expect from us and what we expect from you. If anything here is unclear, ask "
          "your manager or email the People team at people@kettlewick.example."),
    ("h2", "2. Working hours and remote work"),
    ("p", "Our core hours are 10:00 to 15:00 local time, Monday to Friday. Outside core hours you can "
          "arrange your day as you like, as long as you work your contracted hours (usually 40 per week)."),
    ("p", "Office and roastery staff may work remotely up to three days per week. Cafe and roastery "
          "production roles are on-site by nature; their schedules are published two weeks in advance. "
          "Fully remote arrangements need written approval from your department head."),
    ("h2", "3. Home office stipend"),
    ("p", "Employees who work remotely at least one day per week receive a one-time home office stipend "
          "of <b>$600</b> in their first 90 days, plus <b>$150 per year</b> after that for upkeep. Equipment "
          "bought with the stipend is yours to keep."),
    ("break", None),
    ("h2", "4. Paid time off"),
    ("p", "Full-time employees receive <b>15 days</b> of paid vacation per year during their first three "
          "years. From the start of year four, this rises to <b>20 days</b> per year. Part-time employees "
          "receive vacation in proportion to their contracted hours."),
    ("p", "Vacation accrues monthly. You can carry over up to <b>5 unused days</b> into the next calendar "
          "year; any additional unused days expire on 31 March. Request vacation in the HR portal at least "
          "two weeks ahead for anything longer than three days."),
    ("p", "In addition, everyone gets <b>8 paid sick days</b> per year. Sick days do not carry over. For "
          "absences longer than three consecutive days, we ask for a doctor's note."),
    ("p", "Kettlewick observes 10 public holidays per year. Cafe staff who work on a public holiday are "
          "paid 1.5 times their normal rate and receive a replacement day off."),
    ("h2", "5. Parental leave"),
    ("p", "Primary caregivers receive <b>16 weeks</b> of fully paid parental leave. Secondary caregivers "
          "receive <b>6 weeks</b> of fully paid leave. Leave can be taken any time within 12 months of a "
          "birth or adoption, and can be split into up to two blocks. You become eligible after six months "
          "of employment."),
    ("break", None),
    ("h2", "6. Expenses and travel"),
    ("p", "Kettlewick reimburses reasonable business expenses. Submit receipts through the finance portal "
          "within <b>30 days</b> of the purchase; claims older than 60 days cannot be reimbursed."),
    ("ul", [
        "Meals while travelling: up to <b>$45 per day</b>, including tips.",
        "Hotels: up to $180 per night in most cities, $260 per night in New York, London and Tokyo.",
        "Flights: economy class for trips under 6 hours; premium economy is allowed for longer flights.",
        "Any single expense over <b>$500</b> needs your manager's approval before you spend it.",
        "Alcohol is not reimbursed, except at approved client events.",
    ]),
    ("p", "Reimbursements are paid with the next payroll run after approval, usually within two weeks."),
    ("h2", "7. Learning budget"),
    ("p", "Each employee has a learning budget of $1,000 per year for courses, books, conferences and "
          "certifications related to their role, such as barista or Q Grader certification. Unused budget "
          "does not roll over."),
    ("break", None),
    ("h2", "8. Your first week"),
    ("ul", [
        "Day 1: laptop and accounts setup, a welcome coffee tasting with the founders.",
        "Day 2: safety training at the roastery (required for all staff, including remote roles).",
        "Days 3 to 4: shadow a teammate and meet your onboarding buddy.",
        "Day 5: 30-day goals agreed with your manager.",
    ]),
    ("p", "Every new hire has a 90-day probation period. You and your manager will hold check-ins at "
          "30, 60 and 90 days."),
    ("h2", "9. Code of conduct"),
    ("p", "Treat colleagues, customers and suppliers with respect. Harassment and discrimination of any kind "
          "are not tolerated. Report concerns to your manager, the People team, or anonymously through the "
          "ethics line. Retaliation against anyone who raises a concern in good faith is itself a serious "
          "violation."),
    ("h2", "10. Staff discount"),
    ("p", "Employees get 40% off coffee and equipment in our online store and cafes, and one free bag of "
          "coffee (up to 340 g) per week."),
]

MANUAL = [
    ("h1", "Aria Home Espresso Machine: User Manual"),
    ("note", "Model KW-ARIA-2. Sold by Kettlewick Coffee Co., a fictional company used for demonstration."),
    ("h2", "1. Specifications"),
    ("ul", [
        "Pump pressure: 15 bar (extraction runs at 9 bar)",
        "Water tank: 1.8 litres, removable",
        "Heat-up time: about 45 seconds with the thermoblock",
        "Power: 1,450 W, 220 to 240 V",
        "Weight: 6.2 kg",
    ]),
    ("h2", "2. First use"),
    ("p", "Rinse the water tank and fill it with fresh, cold water. Plug in the machine and press the power "
          "button. Before your first coffee, run two full tanks of water through the group head and the steam "
          "wand to flush the system. This removes any residue from manufacturing."),
    ("h2", "3. Making an espresso"),
    ("ul", [
        "Use 18 g of finely ground coffee in the double basket.",
        "Tamp evenly with about 15 kg of pressure.",
        "Lock the portafilter and press the double-shot button.",
        "Aim for 36 g of espresso in 25 to 30 seconds. Grind finer if it runs fast, coarser if it runs slow.",
    ]),
    ("break", None),
    ("h2", "4. Descaling"),
    ("p", "Descale the Aria <b>every 2 months, or after 300 shots</b>, whichever comes first. In hard-water "
          "areas, descale monthly. When descaling is due, the cup icon blinks orange."),
    ("ul", [
        "Empty the water tank and add 500 ml of water mixed with one sachet of Kettlewick descaler.",
        "Place a 1-litre container under the group head and steam wand.",
        "Hold the power and steam buttons together for 5 seconds to start the descaling cycle.",
        "The cycle takes about 20 minutes. Rinse the tank and run one full tank of clean water afterwards.",
    ]),
    ("p", "Do not use vinegar. It can damage the seals and is not covered by the warranty."),
    ("h2", "5. Daily cleaning"),
    ("p", "Purge and wipe the steam wand after every use. Rinse the portafilter and baskets daily. Empty the "
          "drip tray when the red float rises. Once a week, backflush the group head with the blind basket."),
    ("break", None),
    ("h2", "6. Error codes"),
    ("table", [
        ["Code", "Meaning", "What to do"],
        ["E01", "Water tank empty or not seated", "Refill the tank and press it down firmly until it clicks."],
        ["E02", "Boiler overheating", "Switch off and let the machine cool for 30 minutes. If it repeats, contact support."],
        ["E03", "Pump blocked or air in the system", "Run the steam wand for 10 seconds, then try again. Descale if it persists."],
        ["E04", "Grinder or portafilter jam", "Remove the portafilter, check for over-tamped coffee, and clean the shower screen."],
        ["E05", "Temperature sensor fault", "Not user-serviceable. Contact support for a warranty repair."],
        ["E06", "Descaling overdue", "Run the descaling cycle in section 4. The machine stays usable for 50 more shots."],
    ]),
    ("h2", "7. Warranty"),
    ("p", "The Aria has a <b>2-year limited warranty</b> from the date of purchase, covering defects in "
          "materials and workmanship. Registering the machine within 30 days extends the warranty to "
          "3 years. The warranty does not cover damage from scale build-up, vinegar, commercial use, "
          "or repairs by unauthorised technicians. See the Returns and Warranty Policy for how to file a claim."),
]

SUPPORT_MD = """# Kettlewick Coffee Co. Customer Returns and Warranty Policy

_Kettlewick Coffee Co. is a fictional company used for demonstration. Last updated 15 January 2026._

## Returns on equipment

You can return unused equipment (grinders, espresso machines, kettles, brewers) within **30 days** of delivery for a full refund. Items must be in their original packaging with all accessories.

Opened or used equipment can be returned within 30 days for a refund minus a **15% restocking fee**, as long as it is clean and undamaged.

Return shipping is free for orders over $75 in the continental US. For smaller orders, we deduct a $9.95 return label fee from your refund.

## Returns on coffee

Because coffee is a food product, we can't accept returns of opened bags. If you don't love a coffee, tell us within **14 days** and we'll send you a different coffee of equal value, once per order. Unopened bags can be returned within 30 days.

Subscription coffee can be paused, skipped or cancelled at any time before the next roast date, which is shown in your account. Changes made after the roast date apply to the following shipment.

## Refund timing

Refunds go back to the original payment method within **5 to 7 business days** after we receive and inspect your return. Store credit is issued immediately and includes a 10% bonus.

## Filing a warranty claim

1. Email support@kettlewick.example with your order number, the serial number (under the drip tray) and a short video of the problem.
2. Our team replies within one business day with troubleshooting steps or a prepaid shipping label.
3. Repairs take 7 to 10 business days. If we can't repair the machine, we replace it with the same or an equivalent model.

Machines registered within 30 days of purchase get a third year of warranty coverage. During any warranty repair longer than 7 days, we lend you a loaner machine on request.

## Damaged or lost deliveries

Report damaged deliveries within **48 hours** with photos of the box and the item. We'll ship a replacement right away at no cost. If tracking shows no movement for 7 days, we treat the parcel as lost and reship it.

## International orders

We ship to Canada, the UK and the EU. International customers pay return shipping, and import duties are not refundable. Warranty repairs for international customers are handled through our partner service centres; contact support for the nearest one.

## Contact

Support hours are 8:00 to 18:00 Eastern Time, Monday to Saturday. Live chat is available on the website during those hours, and email replies are sent within one business day.
"""

build("Kettlewick Employee Handbook.pdf", "Employee Handbook", HANDBOOK)
build("Aria Espresso Machine Manual.pdf", "Aria User Manual", MANUAL)
(OUT / "Returns and Warranty Policy.md").write_text(SUPPORT_MD, encoding="utf-8")
print("wrote Returns and Warranty Policy.md")
