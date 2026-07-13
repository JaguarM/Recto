import cv2
import numpy as np

def find_redaction_boxes_in_image(image_bytes):
    """
    Decodes image bytes and finds pure black rectangular boxes (>= 17x10).
    Uses a row-by-row scan algorithm handles crosses and ladders by tracking contained runs.
    """
    img_array = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    
    if img is None:
        return [], 0, 0
        
    if len(img.shape) == 2:
        gray = img
    elif img.shape[2] == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    elif img.shape[2] == 4:
        gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    else:
        gray = img
        
    # threshold for pure black
    mask = gray < 10
    
    boxes = []
    active_runs = {} # (sx, ex) -> {'start_y': y, 'history': []}
    
    height = mask.shape[0]
    
    for y in range(height):
        row_mask = mask[y]
        
        # pad with False to easily find runs using np.diff
        padded = np.concatenate(([False], row_mask, [False]))
        diff = np.diff(padded.astype(np.int8))
        
        run_starts = np.where(diff == 1)[0]
        run_ends = np.where(diff == -1)[0]
        
        current_segments = []
        for sx, ex in zip(run_starts, run_ends):
            if ex - sx >= 17:
                current_segments.append((sx, ex))
                
        next_active_runs = {}
        claimed_current = set()
        
        for run, run_data in active_runs.items():
            sx, ex = run
            survives = False
            survived_csx, survived_cex = None, None
            for (csx, cex) in current_segments:
                # The active run survives if it is mostly contained within a current segment
                if csx <= sx + 2 and cex >= ex - 2:
                    survives = True
                    survived_csx = csx
                    survived_cex = cex
                    break
            
            if survives:
                last_hx, last_hex = run_data['history'][-1]
                if abs((survived_cex - survived_csx) - (last_hex - last_hx)) <= 6:
                    claimed_current.add((survived_csx, survived_cex))
                new_history = run_data['history'] + [(survived_csx, survived_cex)]
                next_active_runs[run] = {'start_y': run_data['start_y'], 'history': new_history}
            else:
                start_y = run_data['start_y']
                h = y - start_y
                if h >= 10:
                    # Filter out circular hole-punches by checking if the top and bottom edges are tapered.
                    core_x = max(hx for hx, _ in run_data['history'])
                    core_ex = min(hex for _, hex in run_data['history'])
                    
                    if core_ex - core_x >= 17:
                        width = int(core_ex - core_x)
                        missing_top = width - int(np.sum(mask[start_y - 1, core_x:core_ex])) if start_y > 0 else width
                        missing_bottom = width - int(np.sum(mask[y, core_x:core_ex])) if y < height else width
                        
                        # If BOTH ends are tapered (small missing pixels, but not 0 since otherwise it would have continued) 
                        if missing_top <= width * 0.3 and missing_bottom <= width * 0.3:
                            pass # Reject tapered shape (circle)
                        else:
                            boxes.append((int(core_x), start_y, int(core_ex), start_y + h))
                    
        for c_run in current_segments:
            if c_run not in claimed_current and c_run not in next_active_runs:
                next_active_runs[c_run] = {'start_y': y, 'history': [(c_run[0], c_run[1])]}
                
        active_runs = next_active_runs
        
    for run, run_data in active_runs.items():
        sx, ex = run
        start_y = run_data['start_y']
        h = height - start_y
        if h >= 10:
            core_x = max(hx for hx, _ in run_data['history'])
            core_ex = min(hex for _, hex in run_data['history'])
            
            if core_ex - core_x >= 17:
                width = int(core_ex - core_x)
                missing_top = width - int(np.sum(mask[start_y - 1, core_x:core_ex])) if start_y > 0 else width
                missing_bottom = width
                if missing_top <= width * 0.3 and missing_bottom <= width * 0.3:
                    pass
                else:
                    boxes.append((int(core_x), start_y, int(core_ex), start_y + h))
            
    def clean_overlapping_boxes(raw_boxes):
        cleaned = []
        for i, (ax1, ay1, ax2, ay2) in enumerate(raw_boxes):
            new_ay2 = ay2
            aw = ax2 - ax1
            for j, (bx1, by1, bx2, by2) in enumerate(raw_boxes):
                if i == j: continue
                bw = bx2 - bx1
                # If B starts during A
                if ay1 < by1 < ay2:
                    # If B horizontally mostly contains A 
                    if bx1 <= ax1 + 2 and bx2 >= ax2 - 2:
                        # If B is significantly wider (it's the 'base' of the intersecting T)
                        if bw >= aw + 10:
                            # If they end at roughly the same Y (upward T)
                            if abs(ay2 - by2) <= 5:
                                if by1 < new_ay2:
                                    new_ay2 = by1
            if new_ay2 - ay1 >= 10:
                cleaned.append((ax1, ay1, ax2, new_ay2))
        return cleaned

    boxes = clean_overlapping_boxes(boxes)
    # Deduplicate and sort
    final_boxes = sorted(list(set(boxes)), key=lambda b: (b[1], b[0]))
    return final_boxes, img.shape[1], img.shape[0]
