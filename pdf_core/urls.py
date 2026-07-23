from django.urls import path

from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('open-document', views.open_document, name='open_document'),
    path('open-default', views.open_default, name='open_default'),
    path('page-image/<str:doc_hash>/<int:page_num>', views.page_image, name='page_image'),
]
