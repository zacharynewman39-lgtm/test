"""Classify BodyParts3D structures into tissues/layers and give each tissue
its look and physical properties (density, blood content)."""
import re

# tissue -> (layer, display rgb 0-255, density g/mL, blood fraction by volume)
TISSUES = {
    'bone':        ('skeleton',  (226, 214, 190), 1.85, 0.04),
    'marrow':      ('skeleton',  (150, 40, 40),   1.03, 0.30),
    'cartilage':   ('skeleton',  (205, 215, 222), 1.10, 0.00),
    'disc':        ('skeleton',  (200, 205, 200), 1.10, 0.00),
    'muscle':      ('muscle',    (150, 38, 36),   1.06, 0.03),
    'tendon':      ('muscle',    (225, 220, 205), 1.12, 0.01),
    'artery':      ('vessels',   (190, 22, 24),   1.06, 0.60),
    'vein':        ('vessels',   (70, 25, 60),    1.06, 0.80),
    'heart':       ('organs',    (128, 34, 36),   1.06, 0.20),
    'heart_blood': ('organs',    (90, 8, 10),     1.06, 1.00),
    'brain':       ('cns',       (206, 172, 166), 1.04, 0.05),
    'white_matter': ('cns',      (228, 214, 200), 1.04, 0.03),
    'brainstem':   ('cns',       (210, 186, 170), 1.04, 0.05),
    'cerebellum':  ('cns',       (196, 150, 142), 1.04, 0.06),
    'csf':         ('cns',       (200, 210, 220), 1.007, 0.0),
    'spinal_cord': ('cns',       (232, 222, 200), 1.04, 0.04),
    'nerve':       ('nerves',    (238, 226, 170), 1.04, 0.01),
    'lung':        ('organs',    (214, 128, 132), 0.30, 0.10),
    'airway':      ('organs',    (225, 200, 196), 1.10, 0.02),
    'liver':       ('organs',    (110, 36, 28),   1.05, 0.12),
    'duct':        ('organs',    (120, 150, 60),  1.03, 0.0),
    'gallbladder': ('organs',    (60, 110, 50),   1.02, 0.02),
    'stomach':     ('organs',    (210, 140, 130), 1.04, 0.05),
    'intestine':   ('organs',    (212, 150, 130), 1.04, 0.05),
    'colon':       ('organs',    (190, 140, 115), 1.04, 0.05),
    'mesentery':   ('organs',    (232, 196, 120), 0.95, 0.04),
    'pancreas':    ('organs',    (220, 180, 140), 1.05, 0.08),
    'esophagus':   ('organs',    (200, 120, 110), 1.05, 0.05),
    'spleen':      ('organs',    (100, 30, 60),   1.05, 0.30),
    'kidney':      ('organs',    (120, 40, 36),   1.05, 0.25),
    'urinary':     ('organs',    (220, 180, 150), 1.03, 0.03),
    'gland':       ('organs',    (200, 140, 90),  1.05, 0.10),
    'reproductive': ('organs',   (200, 140, 130), 1.04, 0.05),
    'eye':         ('organs',    (240, 240, 235), 1.01, 0.01),
    'fat':         ('fat',       (232, 196, 110), 0.92, 0.02),
}

EXCLUDE = re.compile(r'^(Skin|Hair of head|Eyebrow|Pubic hair|Lip|External ear|Tongue)$|tooth|Gingiva|'
                     r'^(Left|Right) (cornea|sclera|lens|iris|choroid|vitreous body)$|Optic part of .* retina|'
                     r'Anterior chamber|corona ciliaris|Suspensory ligament of', re.I)
MUSCLE_IN_SKELETAL = re.compile(r'fibularis|tibialis|levator scapulae|subscapularis|tensor fasciae', re.I)


def classify(name, system):
    n = name.lower()
    if 'hepatovenous segment' in n:
        return 'liver'  # Couinaud liver segments are filed under 'venous'
    if 'choroid plexus' in n:
        return 'csf'
    if system == 'skeletal':
        if MUSCLE_IN_SKELETAL.search(n):
            return 'muscle'
        if 'iliotibial' in n:
            return 'tendon'
        if 'disk' in n:
            return 'disc'
        if 'cartilage' in n:
            return 'cartilage'
        return 'bone'
    if system == 'muscular':
        if re.search(r'tendon|aponeurosis|fascia|retinaculum|ligament', n):
            return 'tendon'
        return 'muscle'
    if system == 'connective':
        if 'tensor fasciae' in n:
            return 'muscle'
        return 'tendon'
    if system == 'arterial':
        return 'artery'
    if system == 'venous':
        return 'vein'
    if system == 'cardiac':
        if 'cavity of' in n:
            return 'heart_blood'
        if 'ventricle' in n and 'wall' not in n or 'interventricular foramen' in n:
            return 'csf'  # brain ventricles live in this group in the source
        return 'heart'
    if system == 'nervous':
        if re.search(r'nerve|ganglion|chiasm|optic tract', n):
            return 'nerve'
        if re.search(r'medulla|pons|midbrain|peduncle', n):
            return 'brainstem'
        if 'cerebellum' in n:
            return 'cerebellum'
        if 'white matter' in n or 'corpus callosum' in n or 'internal capsule' in n:
            return 'white_matter'
        if 'canal' in n or 'aqueduct' in n:
            return 'csf'
        return 'brain'
    if system == 'respiratory':
        if re.search(r'bronch|trachea', n):
            return 'airway'
        if re.search(r'constrictor|palatopharyngeus|salpingopharyngeus|stylopharyngeus', n):
            return 'muscle'
        return 'cartilage'
    if system == 'digestive':
        if re.search(r'hepatovenous|lobe of liver|liver', n) and 'duct' not in n and 'biliary' not in n:
            return 'liver'
        if re.search(r'duct|biliary', n):
            return 'duct'
        if 'gallbladder' in n:
            return 'gallbladder'
        if 'stomach' in n:
            return 'stomach'
        if re.search(r'duoden|jejun|ile', n):
            return 'intestine'
        if re.search(r'colon|rectum|appendix|cecum', n):
            return 'colon'
        if 'mes' in n:
            return 'mesentery'
        if 'pancrea' in n:
            return 'pancreas'
        if 'esophag' in n:
            return 'esophagus'
        return 'intestine'
    if system == 'urinary':
        return 'kidney' if 'kidney' in n else 'urinary'
    if system == 'lymphatic':
        return 'spleen' if 'spleen' in n else 'gland'
    if system == 'endocrine':
        return 'gland'
    if system == 'reproductive':
        return 'reproductive'
    if system == 'sensory':
        if re.search(r'lacrimal gland', n):
            return 'gland'
        if re.search(r'bone', n):
            return 'bone'
        return 'tendon'
    return 'tendon'
