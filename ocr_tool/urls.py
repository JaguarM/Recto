from django.urls import path

from . import views

urlpatterns = [
    path('ocr/cache/<str:doc_hash>', views.ocr_cache, name='ocr_cache'),
]
