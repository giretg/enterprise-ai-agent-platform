-- Wiki menüsorrend: kategóriánként explicit sorrend („nincs megadva” is), oldalrendezés,
-- kiemelt oldalak, alapból becsukott csoport. A meglévő sorrend-értékek megmaradnak.

-- CreateEnum
CREATE TYPE "WikiPageSort" AS ENUM ('title', 'updated_desc', 'date_desc', 'manual');

-- AlterTable
ALTER TABLE "wiki_categories" ALTER COLUMN "sort_order" DROP NOT NULL,
ALTER COLUMN "sort_order" DROP DEFAULT,
ADD COLUMN     "page_sort" "WikiPageSort" NOT NULL DEFAULT 'title',
ADD COLUMN     "pinned_pages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "page_order" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "collapsed" BOOLEAN NOT NULL DEFAULT false;
